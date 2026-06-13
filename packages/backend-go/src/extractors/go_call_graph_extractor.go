// Go CallGraph extractor for Stele Phase B (trace-policy + effect-policy).
//
// A faithful, stdlib-only port of python_call_graph_extractor.py: reads a JSON
// request on stdin ({project_root, source_files?}), parses the project's .go
// files with go/parser (no go/types, no external modules — runs via `go run`
// with zero deps), and emits the language-agnostic CallGraph JSON on stdout.
//
// Soundness mirrors the Python extractor: every call resolves to an EDGE, or an
// UnresolvedCall carrying `nameHidden` (true only when the callee identity is
// not statically recoverable — computed/reflective dispatch — so the trace
// fail-closed gate can fire), or is dropped as a language builtin. NodeIds are
// arity-less (`file::Func`, `file::Recv::Method`), which @stele/call-graph-core
// parseNodeId accepts.
package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

const schemaVersion = "1"
const language = "go"

type request struct {
	ProjectRoot string   `json:"project_root"`
	SourceFiles []string `json:"source_files"`
}

type span struct {
	Line   int `json:"line"`
	Column int `json:"column"`
}

type node struct {
	ID         string   `json:"id"`
	Kind       string   `json:"kind"`
	FilePath   string   `json:"filePath"`
	Span       span     `json:"span"`
	Signature  string   `json:"signature"`
	IsExported bool     `json:"isExported"`
	IsAsync    bool     `json:"isAsync"`
	Effects    []string `json:"effects,omitempty"`
}

type edge struct {
	FromID        string `json:"fromId"`
	ToID          string `json:"toId"`
	CallSite      span   `json:"callSite"`
	IsConditional bool   `json:"isConditional"`
	IsLoop        bool   `json:"isLoop"`
	IsAsync       bool   `json:"isAsync"`
}

type unresolved struct {
	FromID     string `json:"fromId"`
	CallSite   span   `json:"callSite"`
	RawText    string `json:"rawText"`
	Reason     string `json:"reason"`
	NameHidden bool   `json:"nameHidden"`
}

type callGraph struct {
	SchemaVersion        string            `json:"schemaVersion"`
	Language             string            `json:"language"`
	GeneratedAt          string            `json:"generatedAt"`
	ProjectRoot          string            `json:"projectRoot"`
	Nodes                []node            `json:"nodes"`
	Edges                []edge            `json:"edges"`
	UnresolvedCalls      []unresolved      `json:"unresolvedCalls"`
	AmbiguousCalls       []any             `json:"ambiguousCalls"`
	MethodResolutionHash string            `json:"methodResolutionHash"`
	FileHashes           map[string]string `json:"fileHashes"`
}

// Go predeclared functions — calls to these are language builtins, not edges.
var goBuiltins = map[string]bool{
	"append": true, "cap": true, "clear": true, "close": true, "complex": true,
	"copy": true, "delete": true, "imag": true, "len": true, "make": true,
	"max": true, "min": true, "new": true, "panic": true, "print": true,
	"println": true, "real": true, "recover": true,
}

type extractor struct {
	root  string
	fset  *token.FileSet
	files map[string]*ast.File // rel -> file
	// per-package (directory) index: dir -> funcName/"Recv.Method" -> NodeId
	pkgDefs map[string]map[string]string
	// rel -> imported local package names (for `pkg.Func()` external classification)
	imports map[string]map[string]bool

	nodes      []node
	edges      []edge
	unresolved []unresolved
	fileHashes map[string]string
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "go-callgraph:", err)
		os.Exit(1)
	}
}

func run() error {
	raw, err := io.ReadAll(os.Stdin)
	if err != nil {
		return err
	}
	var req request
	if err := json.Unmarshal(raw, &req); err != nil {
		return fmt.Errorf("bad request json: %w", err)
	}
	if req.ProjectRoot == "" {
		return fmt.Errorf("project_root required")
	}
	ex := &extractor{
		root:       req.ProjectRoot,
		fset:       token.NewFileSet(),
		files:      map[string]*ast.File{},
		pkgDefs:    map[string]map[string]string{},
		imports:    map[string]map[string]bool{},
		fileHashes: map[string]string{},
	}

	goFiles, err := ex.discover(req.SourceFiles)
	if err != nil {
		return err
	}
	// First pass: parse + index defs.
	for _, rel := range goFiles {
		ex.parseAndIndex(rel)
	}
	// Second pass: emit nodes + edges.
	for _, rel := range goFiles {
		if f := ex.files[rel]; f != nil {
			ex.emit(rel, f)
		}
	}

	g := ex.build()
	out, err := json.Marshal(g)
	if err != nil {
		return err
	}
	_, err = os.Stdout.Write(out)
	return err
}

func (ex *extractor) discover(sourceFiles []string) ([]string, error) {
	var rels []string
	if len(sourceFiles) > 0 {
		for _, f := range sourceFiles {
			if strings.HasSuffix(f, ".go") && !strings.HasSuffix(f, "_test.go") {
				rels = append(rels, filepath.ToSlash(f))
			}
		}
		sort.Strings(rels)
		return rels, nil
	}
	err := filepath.Walk(ex.root, func(p string, info os.FileInfo, err error) error {
		if err != nil {
			return nil // best-effort
		}
		if info.IsDir() {
			base := info.Name()
			if base == "vendor" || base == "testdata" || base == "node_modules" ||
				(strings.HasPrefix(base, ".") && base != ".") {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(p, ".go") || strings.HasSuffix(p, "_test.go") {
			return nil
		}
		rel, rerr := filepath.Rel(ex.root, p)
		if rerr != nil {
			return nil
		}
		rels = append(rels, filepath.ToSlash(rel))
		return nil
	})
	sort.Strings(rels)
	return rels, err
}

func (ex *extractor) parseAndIndex(rel string) {
	abs := filepath.Join(ex.root, filepath.FromSlash(rel))
	src, err := os.ReadFile(abs)
	if err != nil {
		return
	}
	sum := sha256.Sum256(src)
	ex.fileHashes[rel] = hex.EncodeToString(sum[:])
	f, err := parser.ParseFile(ex.fset, abs, src, parser.ParseComments)
	if err != nil {
		// Parse error: record the hash, skip indexing (a file we can't parse
		// contributes no edges; calls into it surface as unresolved elsewhere).
		return
	}
	ex.files[rel] = f

	dir := pkgDir(rel)
	if ex.pkgDefs[dir] == nil {
		ex.pkgDefs[dir] = map[string]string{}
	}
	imp := map[string]bool{}
	for _, spec := range f.Imports {
		name := importLocalName(spec)
		if name != "" {
			imp[name] = true
		}
	}
	ex.imports[rel] = imp

	for _, decl := range f.Decls {
		fn, ok := decl.(*ast.FuncDecl)
		if !ok {
			continue
		}
		id, key := ex.funcNodeID(rel, fn)
		ex.pkgDefs[dir][key] = id
	}
}

func (ex *extractor) emit(rel string, f *ast.File) {
	dir := pkgDir(rel)
	for _, decl := range f.Decls {
		fn, ok := decl.(*ast.FuncDecl)
		if !ok || fn.Body == nil {
			continue
		}
		id, _ := ex.funcNodeID(rel, fn)
		kind := "function"
		recv := receiverType(fn)
		if recv != "" {
			kind = "method"
		}
		n := node{
			ID:         id,
			Kind:       kind,
			FilePath:   rel,
			Span:       ex.spanOf(fn.Pos()),
			Signature:  signature(fn, recv),
			IsExported: ast.IsExported(fn.Name.Name),
			IsAsync:    false,
		}
		if effs := extractEffects(fn.Doc); len(effs) > 0 {
			n.Effects = effs
		}
		ex.nodes = append(ex.nodes, n)

		// Receiver name (for `r.Method()` self-dispatch resolution).
		recvName := receiverName(fn)
		ast.Inspect(fn.Body, func(nd ast.Node) bool {
			call, ok := nd.(*ast.CallExpr)
			if !ok {
				return true
			}
			ex.handleCall(rel, dir, id, recv, recvName, call)
			return true
		})
	}
}

func (ex *extractor) handleCall(rel, dir, fromID, recvType, recvName string, call *ast.CallExpr) {
	raw := truncate(exprText(ex.fset, call), 200)
	site := ex.spanOf(call.Pos())
	defs := ex.pkgDefs[dir]
	imp := ex.imports[rel]

	switch fun := call.Fun.(type) {
	case *ast.Ident:
		name := fun.Name
		if goBuiltins[name] {
			return // language builtin — not an edge
		}
		if id, ok := defs[name]; ok {
			ex.addEdge(fromID, id, site)
			return
		}
		// Visible bare name that didn't resolve (defined elsewhere / external).
		ex.addUnresolved(fromID, site, raw, "dynamic", false)
	case *ast.SelectorExpr:
		sel := fun.Sel.Name
		if base, ok := fun.X.(*ast.Ident); ok {
			if imp[base.Name] {
				// `pkg.Func()` — imported package call. Name is visible.
				ex.addUnresolved(fromID, site, raw, "external-lib", false)
				return
			}
			if recvType != "" && base.Name == recvName {
				// `r.Method()` inside a method — same-receiver dispatch.
				if id, ok := defs[recvType+"."+sel]; ok {
					ex.addEdge(fromID, id, site)
					return
				}
			}
			// Receiver is a local var/param/field of unknown type. Method name
			// is visible → not a hidden bypass (mirrors Python's obj.method()).
			ex.addUnresolved(fromID, site, raw, "dynamic", false)
			return
		}
		// Base is a computed expression (call/index/etc): `f().M()`, `a[i].M()`.
		// The METHOD name is still visible → name not hidden (mirrors Python).
		ex.addUnresolved(fromID, site, raw, "dynamic", false)
	default:
		// Computed callee: `getFn()()`, `funcs[i]()`, an IIFE, reflect-style
		// dispatch. The callee identity is NOT statically recoverable → fail
		// closed (nameHidden = true).
		ex.addUnresolved(fromID, site, raw, "dynamic", true)
	}
}

func (ex *extractor) addEdge(from, to string, site span) {
	ex.edges = append(ex.edges, edge{FromID: from, ToID: to, CallSite: site})
}

func (ex *extractor) addUnresolved(from string, site span, raw, reason string, nameHidden bool) {
	ex.unresolved = append(ex.unresolved, unresolved{
		FromID: from, CallSite: site, RawText: raw, Reason: reason, NameHidden: nameHidden,
	})
}

func (ex *extractor) funcNodeID(rel string, fn *ast.FuncDecl) (id string, key string) {
	recv := receiverType(fn)
	if recv != "" {
		return rel + "::" + recv + "::" + fn.Name.Name, recv + "." + fn.Name.Name
	}
	return rel + "::" + fn.Name.Name, fn.Name.Name
}

func (ex *extractor) spanOf(pos token.Pos) span {
	p := ex.fset.Position(pos)
	return span{Line: p.Line, Column: p.Column}
}

func (ex *extractor) build() callGraph {
	sort.Slice(ex.nodes, func(i, j int) bool { return ex.nodes[i].ID < ex.nodes[j].ID })
	sort.Slice(ex.edges, func(i, j int) bool {
		a, b := ex.edges[i], ex.edges[j]
		if a.FromID != b.FromID {
			return a.FromID < b.FromID
		}
		if a.ToID != b.ToID {
			return a.ToID < b.ToID
		}
		if a.CallSite.Line != b.CallSite.Line {
			return a.CallSite.Line < b.CallSite.Line
		}
		return a.CallSite.Column < b.CallSite.Column
	})
	sort.Slice(ex.unresolved, func(i, j int) bool {
		a, b := ex.unresolved[i], ex.unresolved[j]
		if a.FromID != b.FromID {
			return a.FromID < b.FromID
		}
		if a.CallSite.Line != b.CallSite.Line {
			return a.CallSite.Line < b.CallSite.Line
		}
		return a.CallSite.Column < b.CallSite.Column
	})
	// Deterministic methodResolutionHash over the resolved edges.
	h := sha256.New()
	for _, e := range ex.edges {
		fmt.Fprintf(h, "%s->%s@%d:%d\n", e.FromID, e.ToID, e.CallSite.Line, e.CallSite.Column)
	}
	if ex.nodes == nil {
		ex.nodes = []node{}
	}
	if ex.edges == nil {
		ex.edges = []edge{}
	}
	if ex.unresolved == nil {
		ex.unresolved = []unresolved{}
	}
	return callGraph{
		SchemaVersion:        schemaVersion,
		Language:             language,
		GeneratedAt:          "1970-01-01T00:00:00Z", // not hashed; fixed for determinism
		ProjectRoot:          ex.root,
		Nodes:                ex.nodes,
		Edges:                ex.edges,
		UnresolvedCalls:      ex.unresolved,
		AmbiguousCalls:       []any{},
		MethodResolutionHash: hex.EncodeToString(h.Sum(nil)),
		FileHashes:           ex.fileHashes,
	}
}

// --- helpers ---

func pkgDir(rel string) string {
	d := filepath.ToSlash(filepath.Dir(rel))
	if d == "." {
		return ""
	}
	return d
}

func receiverType(fn *ast.FuncDecl) string {
	if fn.Recv == nil || len(fn.Recv.List) == 0 {
		return ""
	}
	return baseTypeName(fn.Recv.List[0].Type)
}

func receiverName(fn *ast.FuncDecl) string {
	if fn.Recv == nil || len(fn.Recv.List) == 0 || len(fn.Recv.List[0].Names) == 0 {
		return ""
	}
	return fn.Recv.List[0].Names[0].Name
}

func baseTypeName(e ast.Expr) string {
	switch t := e.(type) {
	case *ast.StarExpr:
		return baseTypeName(t.X)
	case *ast.Ident:
		return t.Name
	case *ast.IndexExpr: // generic receiver Foo[T]
		return baseTypeName(t.X)
	case *ast.IndexListExpr:
		return baseTypeName(t.X)
	}
	return ""
}

func importLocalName(spec *ast.ImportSpec) string {
	if spec.Name != nil {
		if spec.Name.Name == "_" || spec.Name.Name == "." {
			return ""
		}
		return spec.Name.Name
	}
	p := strings.Trim(spec.Path.Value, `"`)
	parts := strings.Split(p, "/")
	return parts[len(parts)-1]
}

func extractEffects(doc *ast.CommentGroup) []string {
	if doc == nil {
		return nil
	}
	var out []string
	seen := map[string]bool{}
	for _, c := range doc.List {
		line := strings.TrimSpace(strings.TrimLeft(c.Text, "/"))
		if !strings.HasPrefix(line, "stele:effects") {
			continue
		}
		for _, tok := range strings.Fields(line)[1:] {
			if !seen[tok] {
				seen[tok] = true
				out = append(out, tok)
			}
		}
	}
	return out
}

func signature(fn *ast.FuncDecl, recv string) string {
	if recv != "" {
		return "func (" + recv + ") " + fn.Name.Name
	}
	return "func " + fn.Name.Name
}

func exprText(fset *token.FileSet, e ast.Expr) string {
	// Best-effort: reconstruct a short textual form for rawText.
	switch x := e.(type) {
	case *ast.CallExpr:
		return exprText(fset, x.Fun) + "(...)"
	case *ast.Ident:
		return x.Name
	case *ast.SelectorExpr:
		return exprText(fset, x.X) + "." + x.Sel.Name
	case *ast.IndexExpr:
		return exprText(fset, x.X) + "[...]"
	case *ast.StarExpr:
		return "*" + exprText(fset, x.X)
	case *ast.ParenExpr:
		return "(" + exprText(fset, x.X) + ")"
	}
	return "<call>"
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}

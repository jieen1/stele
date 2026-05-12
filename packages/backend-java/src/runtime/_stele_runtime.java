package contract;

import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Predicate;
import java.lang.reflect.Method;
import java.math.BigDecimal;

final class SteleRuntime {

    private SteleRuntime() {}

    // --- SteleRuntimeError ---

    public static class SteleRuntimeError extends RuntimeException {
        public SteleRuntimeError(String message) {
            super(message);
        }
    }

    // --- FailureWitness ---

    private static final AtomicInteger WITNESS_COUNTER = new AtomicInteger(0);

    public static class FailureWitness {
        public final String operator;
        public final int collectionSize;
        public final int failedAtIndex;
        public final String failedItem;
        public final String predicateSource;

        public FailureWitness(String operator, int collectionSize, int failedAtIndex,
                              String failedItem, String predicateSource) {
            this.operator = operator;
            this.collectionSize = collectionSize;
            this.failedAtIndex = failedAtIndex;
            this.failedItem = failedItem;
            this.predicateSource = predicateSource;
        }
    }

    private static void emitWitness(FailureWitness witness) {
        String dir = System.getenv("STELE_WITNESS_DIR");
        if (dir == null || dir.isEmpty()) return;
        String filename = "witness-" + WITNESS_COUNTER.getAndIncrement() + ".json";
        String path = dir + java.io.File.separator + filename;
        String json = "{" +
            "\"operator\":\"" + escapeJson(witness.operator) + "\"," +
            "\"collectionSize\":" + witness.collectionSize + "," +
            "\"failedAtIndex\":" + witness.failedAtIndex + "," +
            "\"failedItem\":" + witness.failedItem + "," +
            "\"predicateSource\":\"" + escapeJson(witness.predicateSource) + "\"" +
        "}";
        try {
            java.nio.file.Files.write(
                java.nio.file.Paths.get(path),
                json.getBytes(java.nio.charset.StandardCharsets.UTF_8)
            );
        } catch (Exception e) {
            // best-effort: ignore
        }
    }

    // --- Type checks ---

    public static boolean isNumber(Object value) {
        return value instanceof Number || (!(value instanceof Boolean) && canParseAsNumber(value));
    }

    private static boolean canParseAsNumber(Object value) {
        if (value == null) return false;
        try {
            Long.parseLong(value.toString());
            return true;
        } catch (NumberFormatException e) {
            // ignore
        }
        try {
            Double.parseDouble(value.toString());
            return true;
        } catch (NumberFormatException e) {
            return false;
        }
    }

    public static String asString(Object value) {
        if (value == null) return null;
        return value.toString();
    }

    public static long asLong(Object value) {
        if (value instanceof Long) return (Long) value;
        if (value instanceof Integer) return ((Integer) value).longValue();
        if (value instanceof Double) return ((Double) value).longValue();
        if (value instanceof Short) return ((Short) value).longValue();
        if (value instanceof Float) return ((Float) value).longValue();
        if (value instanceof BigDecimal) return ((BigDecimal) value).longValue();
        throw new SteleRuntimeError("expected integer, got " + value.getClass().getName());
    }

    public static double asDouble(Object value) {
        if (value instanceof Double) return (Double) value;
        if (value instanceof Long) return (double) (Long) value;
        if (value instanceof Integer) return (double) (Integer) value;
        if (value instanceof BigDecimal) return ((BigDecimal) value).doubleValue();
        if (value instanceof Float) return ((Float) value).doubleValue();
        throw new SteleRuntimeError("expected number, got " + value.getClass().getName());
    }

    private static double assertNumber(Object value, String label) {
        return asDouble(value);
    }

    private static String assertString(Object value, String label) {
        if (value == null) throw new SteleRuntimeError(label + ": expected string, got null");
        return value.toString();
    }

    // --- Numeric comparison ---

    public static int numericCompare(Object a, Object b) {
        boolean aIsDouble = a instanceof Double || a instanceof Float || a instanceof BigDecimal;
        boolean bIsDouble = b instanceof Double || b instanceof Float || b instanceof BigDecimal;

        if (!aIsDouble && !bIsDouble) {
            long ai = asLong(a);
            long bi = asLong(b);
            return Long.compare(ai, bi);
        }
        double af = asDouble(a);
        double bf = asDouble(b);
        double diff = af - bf;
        if (Math.abs(diff) < 1e-9) return 0;
        return diff < 0 ? -1 : 1;
    }

    // --- Comparison helpers ---

    public static boolean steleEq(Object a, Object b) {
        if (a == b) return true;
        if (a == null || b == null) return false;
        if (isNumber(a) && isNumber(b)) return numericCompare(a, b) == 0;
        return a.equals(b);
    }

    public static boolean steleNeq(Object a, Object b) {
        return !steleEq(a, b);
    }

    public static boolean steleGt(Object a, Object b) {
        return numericCompare(a, b) > 0;
    }

    public static boolean steleGte(Object a, Object b) {
        return numericCompare(a, b) >= 0;
    }

    public static boolean steleLt(Object a, Object b) {
        return numericCompare(a, b) < 0;
    }

    public static boolean steleLte(Object a, Object b) {
        return numericCompare(a, b) <= 0;
    }

    // --- Arithmetic ---

    public static Object steleAdd(Object a, Object b) {
        if (a instanceof Long && b instanceof Long) {
            return (Long) a + (Long) b;
        }
        return asDouble(a) + asDouble(b);
    }

    public static Object steleSub(Object a, Object b) {
        if (a instanceof Long && b instanceof Long) {
            return (Long) a - (Long) b;
        }
        return asDouble(a) - asDouble(b);
    }

    public static Object steleMul(Object a, Object b) {
        if (a instanceof Long && b instanceof Long) {
            return (Long) a * (Long) b;
        }
        return asDouble(a) * asDouble(b);
    }

    public static Object steleDiv(Object a, Object b) {
        return asDouble(a) / asDouble(b);
    }

    public static Object steleNeg(Object value) {
        if (value instanceof Long) return -(Long) value;
        return -asDouble(value);
    }

    public static Object steleAbs(Object value) {
        if (value instanceof Long) return Math.abs((Long) value);
        return Math.abs(asDouble(value));
    }

    public static Object steleMod(Object a, Object b) {
        double af = asDouble(a);
        double bf = asDouble(b);
        return ((af % bf) + bf) % bf;
    }

    public static Object stelePow(Object a, Object b) {
        return Math.pow(asDouble(a), asDouble(b));
    }

    public static Object steleRound(Object value) {
        double v = asDouble(value);
        return Math.round(v);
    }

    public static Object steleRound(Object value, Object digits) {
        double v = asDouble(value);
        int d = (int) asLong(digits);
        double scale = Math.pow(10, d);
        return Math.round(v * scale) / scale;
    }

    public static Object steleCeil(Object value) {
        return (long) Math.ceil(asDouble(value));
    }

    public static Object steleFloor(Object value) {
        return (long) Math.floor(asDouble(value));
    }

    // --- Aggregates ---

    @SuppressWarnings("unchecked")
    public static Object steleSum(List<Object> items, String... path) {
        long longTotal = 0;
        double doubleTotal = 0.0;
        boolean hasFloat = false;
        for (Object item : items) {
            Object val = path.length == 0 ? item : getAtPath(item, path);
            if (val instanceof Long) {
                longTotal += (Long) val;
            } else if (val instanceof Integer) {
                longTotal += (Integer) val;
            } else if (val instanceof Short) {
                longTotal += ((Short) val).longValue();
            } else if (val instanceof Double) {
                hasFloat = true;
                doubleTotal += (Double) val;
            } else if (val instanceof Float) {
                hasFloat = true;
                doubleTotal += ((Float) val).doubleValue();
            } else if (val instanceof BigDecimal) {
                hasFloat = true;
                doubleTotal += ((BigDecimal) val).doubleValue();
            } else {
                hasFloat = true;
                doubleTotal += asDouble(val);
            }
        }
        if (hasFloat) {
            return (double) longTotal + doubleTotal;
        }
        return longTotal;
    }

    public static long steleCount(List<?> items) {
        return items.size();
    }

    @SuppressWarnings("unchecked")
    public static double steleAvg(List<Object> items, String... path) {
        double sum = 0;
        for (Object item : items) {
            Object val = path.length == 0 ? item : getAtPath(item, path);
            sum += asDouble(val);
        }
        return items.size() == 0 ? 0.0 : sum / items.size();
    }

    @SuppressWarnings("unchecked")
    public static Object steleMin(List<Object> items, String... path) {
        if (items.isEmpty()) return null;
        Object min = path.length == 0 ? items.get(0) : getAtPath(items.get(0), path);
        for (int i = 1; i < items.size(); i++) {
            Object val = path.length == 0 ? items.get(i) : getAtPath(items.get(i), path);
            if (numericCompare(val, min) < 0) min = val;
        }
        return min;
    }

    @SuppressWarnings("unchecked")
    public static Object steleMax(List<Object> items, String... path) {
        if (items.isEmpty()) return null;
        Object max = path.length == 0 ? items.get(0) : getAtPath(items.get(0), path);
        for (int i = 1; i < items.size(); i++) {
            Object val = path.length == 0 ? items.get(i) : getAtPath(items.get(i), path);
            if (numericCompare(val, max) > 0) max = val;
        }
        return max;
    }

    @SuppressWarnings("unchecked")
    public static List<Object> steleDistinct(List<Object> items, String... path) {
        Set<String> seen = new TreeSet<>();
        List<Object> result = new ArrayList<>();
        for (Object item : items) {
            Object val = path.length == 0 ? item : getAtPath(item, path);
            String key = safeSerialize(val, 1);
            if (seen.add(key)) result.add(item);
        }
        return result;
    }

    @SuppressWarnings("unchecked")
    public static boolean steleUnique(List<Object> items, String... path) {
        Set<String> seen = new TreeSet<>();
        for (Object item : items) {
            Object val = path.length == 0 ? item : getAtPath(item, path);
            String key = safeSerialize(val, 1);
            if (!seen.add(key)) return false;
        }
        return true;
    }

    public static boolean steleHasLength(List<?> items, Object length) {
        return items.size() == asLong(length);
    }

    public static boolean steleIsEmpty(List<?> items) {
        return items.isEmpty();
    }

    @SuppressWarnings("unchecked")
    public static boolean steleExistsIn(Object value, List<Object> items) {
        for (Object item : items) {
            if (steleEq(item, value)) return true;
        }
        return false;
    }

    // --- String ---

    public static boolean steleContains(Object value, Object needle) {
        String s = asString(value);
        String n = asString(needle);
        return s.contains(n);
    }

    public static boolean steleStartsWith(Object value, Object prefix) {
        String s = asString(value);
        String p = asString(prefix);
        return s.startsWith(p);
    }

    public static boolean steleEndsWith(Object value, Object suffix) {
        String s = asString(value);
        String sfx = asString(suffix);
        return s.endsWith(sfx);
    }

    public static boolean steleMatches(Object value, Object pattern) {
        String s = asString(value);
        String p = asString(pattern);
        if (hasRedosPattern(p)) {
            throw new SteleRuntimeError("potentially dangerous regex pattern: " + p);
        }
        try {
            return java.util.regex.Pattern.compile(p).matcher(s).find();
        } catch (java.util.regex.PatternSyntaxException e) {
            throw new SteleRuntimeError("invalid regex pattern: " + e.getMessage());
        }
    }

    public static Object steleTrim(Object value) {
        return asString(value).trim();
    }

    public static Object steleLower(Object value) {
        return asString(value).toLowerCase(Locale.ROOT);
    }

    public static Object steleUpper(Object value) {
        return asString(value).toUpperCase(Locale.ROOT);
    }

    public static List<Object> steleSplit(Object value, Object separator) {
        String s = asString(value);
        String sep = asString(separator);
        if (sep.isEmpty()) {
            throw new SteleRuntimeError("split: separator cannot be empty");
        }
        String[] parts = s.split(sep, -1);
        List<Object> result = new ArrayList<>();
        for (String part : parts) result.add(part);
        return result;
    }

    public static Object steleJoin(List<?> items, Object separator) {
        String sep = asString(separator);
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < items.size(); i++) {
            if (i > 0) sb.append(sep);
            sb.append(asString(items.get(i)));
        }
        return sb.toString();
    }

    // --- Control ---

    public static boolean steleNotNull(Object value) {
        return value != null;
    }

    public static boolean steleBetween(Object value, Object low, Object high) {
        int cmpLow = numericCompare(value, low);
        int cmpHigh = numericCompare(value, high);
        return cmpLow >= 0 && cmpHigh <= 0;
    }

    public static boolean steleApproxEq(Object a, Object b, Object tolerance) {
        double diff = Math.abs(asDouble(a) - asDouble(b));
        return diff <= asDouble(tolerance);
    }

    // --- Quantifiers ---

    public static <T> void steleForall(List<T> items, Predicate<T> pred, String predSource) {
        for (int i = 0; i < items.size(); i++) {
            T item = items.get(i);
            if (!pred.test(item)) {
                FailureWitness witness = new FailureWitness(
                    "forall", items.size(), i, safeSerialize(item, 2), predSource
                );
                emitWitness(witness);
                throw new SteleRuntimeError("forall failed at index " + i + ": " + predSource);
            }
        }
    }

    public static <T> boolean steleExists(List<T> items, Predicate<T> pred, String predSource) {
        for (T item : items) {
            if (pred.test(item)) return true;
        }
        throw new SteleRuntimeError("exists: no item satisfies predicate: " + predSource);
    }

    public static <T> List<T> steleWhere(List<T> items, Predicate<T> pred, String predSource) {
        List<T> result = new ArrayList<>();
        for (T item : items) {
            if (pred.test(item)) result.add(item);
        }
        return result;
    }

    public static <T> void steleNone(List<T> items, Predicate<T> pred, String predSource) {
        for (int i = 0; i < items.size(); i++) {
            T item = items.get(i);
            if (pred.test(item)) {
                FailureWitness witness = new FailureWitness(
                    "none", items.size(), i, safeSerialize(item, 2), predSource
                );
                emitWitness(witness);
                throw new SteleRuntimeError("none: item at index " + i + " satisfies predicate: " + predSource);
            }
        }
    }

    // --- Temporal ---

    @SuppressWarnings("unchecked")
    public static boolean steleIsModified(Map<String, Object> root, String... path) {
        Map<String, Object> ctx = (Map<String, Object>) root.get("_stele_context");
        if (ctx == null) throw new SteleRuntimeError("no _stele_context found");
        Object before = ctx.get("stateBefore");
        Object after = ctx.get("stateAfter");
        if (before == null || after == null) throw new SteleRuntimeError("state-before/state-after not set");
        Object bv = getAtPath(before, path);
        Object av = getAtPath(after, path);
        return !steleEq(bv, av);
    }

    @SuppressWarnings("unchecked")
    public static Map<String, Object> steleStateBefore(Map<String, Object> root) {
        Map<String, Object> ctx = (Map<String, Object>) root.get("_stele_context");
        if (ctx == null) throw new SteleRuntimeError("no _stele_context found");
        return (Map<String, Object>) ctx.get("stateBefore");
    }

    @SuppressWarnings("unchecked")
    public static Map<String, Object> steleStateAfter(Map<String, Object> root) {
        Map<String, Object> ctx = (Map<String, Object>) root.get("_stele_context");
        if (ctx == null) throw new SteleRuntimeError("no _stele_context found");
        return (Map<String, Object>) ctx.get("stateAfter");
    }

    public static boolean steleWithin(Object timestamp, Object durationSeconds) {
        double ts = asDouble(timestamp);
        double dur = asDouble(durationSeconds);
        double now = System.currentTimeMillis() / 1000.0;
        return now - ts <= dur;
    }

    public static boolean steleBefore(Object a, Object b) {
        return numericCompare(a, b) < 0;
    }

    public static boolean steleAfter(Object a, Object b) {
        return numericCompare(a, b) > 0;
    }

    // --- EP04 collection extras ---

    public static long steleLength(List<?> items) {
        return items.size();
    }

    @SafeVarargs
    public static List<Object> steleConcat(List<?>... collections) {
        List<Object> result = new ArrayList<>();
        for (List<?> col : collections) {
            result.addAll(col);
        }
        return result;
    }

    @SuppressWarnings("unchecked")
    public static List<Object> steleSortBy(List<Object> items, String... path) {
        List<Object> sorted = new ArrayList<>(items);
        sorted.sort((a, b) -> {
            Object va = getAtPath(a, path);
            Object vb = getAtPath(b, path);
            if (isNumber(va) && isNumber(vb)) return numericCompare(va, vb);
            return asString(va).compareTo(asString(vb));
        });
        return sorted;
    }

    @SuppressWarnings("unchecked")
    public static List<Object> steleSortByDesc(List<Object> items, String... path) {
        List<Object> sorted = new ArrayList<>(items);
        sorted.sort((a, b) -> {
            Object va = getAtPath(a, path);
            Object vb = getAtPath(b, path);
            if (isNumber(va) && isNumber(vb)) return numericCompare(vb, va);
            return asString(vb).compareTo(asString(va));
        });
        return sorted;
    }

    @SuppressWarnings("unchecked")
    public static List<Object> steleMap(List<Object> items, String... path) {
        List<Object> result = new ArrayList<>();
        for (Object item : items) {
            result.add(getAtPath(item, path));
        }
        return result;
    }

    public static Object steleFirst(List<?> items) {
        return items.isEmpty() ? null : items.get(0);
    }

    public static Object steleLast(List<?> items) {
        return items.isEmpty() ? null : items.get(items.size() - 1);
    }

    // --- Data access ---

    public static String steleTypeOf(Object value) {
        if (value == null) return "null";
        if (value instanceof Long) return "number";
        if (value instanceof Integer) return "number";
        if (value instanceof Double) return "number";
        if (value instanceof Float) return "number";
        if (value instanceof Boolean) return "boolean";
        if (value instanceof String) return "string";
        if (value instanceof List) return "collection";
        if (value instanceof Map) return "object";
        return "object";
    }

    // --- Scenario / Checker ---

    private static final Map<String, Method> STELE_SCENARIO_FUNCTIONS = new ConcurrentHashMap<>();

    public static void registerScenarioFunction(String name, Method method) {
        STELE_SCENARIO_FUNCTIONS.put(name, method);
    }

    @FunctionalInterface
    public interface CheckerFunction {
        CheckerResult apply(List<Object> args, Map<String, Object> ctx);
    }

    public static class CheckerResult {
        public final boolean ok;
        public final String message;
        public final Object details;

        public CheckerResult(boolean ok, String message, Object details) {
            this.ok = ok;
            this.message = message;
            this.details = details;
        }
    }

    public static CheckerResult steleCallChecker(
        Map<String, CheckerFunction> checkers, String name, List<Object> args, Map<String, Object> ctx
    ) {
        CheckerFunction fn = checkers.get(name);
        if (fn == null) {
            throw new SteleRuntimeError("checker " + name + " not registered");
        }
        return fn.apply(args, ctx);
    }

    @SuppressWarnings("unchecked")
    public static Map<String, Object> steleRunScenario(
        List<Map<String, Object>> steps, Map<String, Object> ctx
    ) {
        for (Map<String, Object> step : steps) {
            String type = (String) step.get("type");
            switch (type) {
                case "execute": {
                    String funcName = (String) step.get("function");
                    List<Object> args = (List<Object>) step.getOrDefault("args", Collections.emptyList());
                    Method fn = STELE_SCENARIO_FUNCTIONS.get(funcName);
                    if (fn == null) {
                        throw new SteleRuntimeError("scenario function " + funcName + " not registered");
                    }
                    try {
                        Object result = fn.invoke(null, args.toArray());
                        if (step.containsKey("assign")) {
                            String assignPath = (String) step.get("assign");
                            ctx.put(assignPath, result);
                        }
                    } catch (java.lang.reflect.InvocationTargetException e) {
                        throw new SteleRuntimeError("scenario function " + funcName + " threw: "
                            + e.getCause().getMessage());
                    } catch (Exception e) {
                        throw new SteleRuntimeError("failed to invoke scenario function " + funcName
                            + ": " + e.getMessage());
                    }
                    break;
                }
                case "capture-state": {
                    String label = (String) step.getOrDefault("label", "");
                    Map<String, Object> snapshot = new HashMap<>(ctx);
                    if ("before".equals(label) || label.isEmpty()) {
                        step.put("stateBefore", snapshot);
                    } else {
                        step.put("stateAfter", snapshot);
                    }
                    break;
                }
                case "import":
                    String module = (String) step.get("module");
                    assertImportAllowed(module);
                    break;
                default:
                    throw new SteleRuntimeError("unknown scenario step type: " + type);
            }
        }
        return ctx;
    }

    public static Map<String, Object> steleMergeContexts(Map<String, Object> base, Map<String, Object> overlay) {
        Map<String, Object> merged = new LinkedHashMap<>(base);
        for (Map.Entry<String, Object> e : overlay.entrySet()) {
            merged.put(e.getKey(), e.getValue());
        }
        return merged;
    }

    // --- Path access ---

    @SuppressWarnings("unchecked")
    public static Object getAtPath(Object root, String... segments) {
        Object current = root;
        for (String seg : segments) {
            if (current == null) {
                throw new SteleRuntimeError("path navigation hit null at segment: " + seg);
            }
            if (current instanceof Map) {
                Map<String, Object> map = (Map<String, Object>) current;
                if (map.containsKey(seg)) {
                    current = map.get(seg);
                    continue;
                }
                String camel = kebabToCamelCase(seg);
                if (map.containsKey(camel)) {
                    current = map.get(camel);
                    continue;
                }
                throw new SteleRuntimeError("path not found: segment " + seg
                    + " on map with keys " + map.keySet());
            }
            throw new SteleRuntimeError("path navigation hit non-Map at segment: " + seg
                + " (got " + current.getClass().getSimpleName() + ")");
        }
        return current;
    }

    // --- Import allowlist ---

    private static final List<String> STELE_ALLOWED_IMPORTS = Arrays.asList(
        "java.util", "java.lang", "java.math",
        "java.nio.file", "java.nio.charset", "java.io",
        "stele", "org.junit"
    );

    private static void assertImportAllowed(String module) {
        boolean allowed = STELE_ALLOWED_IMPORTS.stream()
            .anyMatch(pattern -> pattern.equals(module) ||
                (pattern.endsWith(".*") &&
                    (module.startsWith(pattern.substring(0, pattern.length() - 2) + ".") ||
                     module.equals(pattern.substring(0, pattern.length() - 2)))));
        if (!allowed) {
            throw new SteleRuntimeError("Module " + module + " is not in the Stele allowlist");
        }
    }

    // --- Helpers ---

    private static final Set<String> STELE_REDACTION_PATTERNS =
        Collections.unmodifiableSet(new HashSet<>(Arrays.asList(
            "password", "token", "secret", "apiKey", "api_key", "accessToken", "access_token"
        )));

    public static String safeSerialize(Object value, int maxDepth) {
        return safeSerializeImpl(value, maxDepth, 0).serialized;
    }

    private static class SerializeResult {
        final String serialized;
        final boolean truncated;
        SerializeResult(String serialized, boolean truncated) {
            this.serialized = serialized;
            this.truncated = truncated;
        }
    }

    @SuppressWarnings("unchecked")
    private static SerializeResult safeSerializeImpl(Object value, int maxDepth, int depth) {
        if (depth > maxDepth) {
            return new SerializeResult("\"<depth-limit>\"", true);
        }
        if (value == null) {
            return new SerializeResult("null", false);
        }
        if (value instanceof String) {
            return new SerializeResult("\"" + escapeJson((String) value) + "\"", false);
        }
        if (value instanceof Number || value instanceof Boolean) {
            return new SerializeResult(value.toString(), false);
        }
        if (value instanceof List) {
            List<?> list = (List<?>) value;
            boolean truncated = list.size() > 100;
            int limit = Math.min(list.size(), 100);
            StringBuilder sb = new StringBuilder("[");
            for (int i = 0; i < limit; i++) {
                if (i > 0) sb.append(",");
                SerializeResult child = safeSerializeImpl(list.get(i), maxDepth, depth + 1);
                sb.append(child.serialized);
                if (child.truncated) truncated = true;
            }
            sb.append("]");
            return new SerializeResult(sb.toString(), truncated);
        }
        if (value instanceof Map) {
            Map<?, ?> rawMap = (Map<?, ?>) value;
            Map.Entry<String, Object>[] entries = new Map.Entry[rawMap.size()];
            int idx = 0;
            for (Map.Entry<?, ?> e : rawMap.entrySet()) {
                String displayKey = e.getKey() instanceof String
                    ? (String) e.getKey()
                    : String.valueOf(e.getKey());
                entries[idx++] = new AbstractMap.SimpleEntry<>(displayKey, e.getValue());
            }
            Arrays.sort(entries, (a, b) -> a.getKey().compareTo(b.getKey()));
            boolean truncated = false;
            StringBuilder sb = new StringBuilder("{");
            for (int i = 0; i < entries.length; i++) {
                Map.Entry<String, Object> entry = entries[i];
                String key = entry.getKey();
                Object val = entry.getValue();
                if (i > 0) sb.append(",");
                sb.append("\"").append(escapeJson(key)).append("\":");
                if (STELE_REDACTION_PATTERNS.stream().anyMatch(p -> key.toLowerCase().contains(p))) {
                    sb.append("\"<redacted>\"");
                } else {
                    SerializeResult child = safeSerializeImpl(val, maxDepth, depth + 1);
                    sb.append(child.serialized);
                    if (child.truncated) truncated = true;
                }
            }
            sb.append("}");
            return new SerializeResult(sb.toString(), truncated);
        }
        return new SerializeResult("\"" + escapeJson(value.toString()) + "\"", false);
    }

    private static String kebabToCamelCase(String kebab) {
        StringBuilder sb = new StringBuilder();
        boolean nextUpper = false;
        for (int i = 0; i < kebab.length(); i++) {
            char c = kebab.charAt(i);
            if (c == '-') {
                nextUpper = true;
            } else if (nextUpper) {
                sb.append(Character.toUpperCase(c));
                nextUpper = false;
            } else {
                sb.append(c);
            }
        }
        return sb.toString();
    }

    private static boolean hasRedosPattern(String pattern) {
        int consecutiveQuantifiers = 0;
        for (int i = 0; i < pattern.length(); i++) {
            char c = pattern.charAt(i);
            if (c == '*' || c == '+' || c == '{') {
                consecutiveQuantifiers++;
                if (consecutiveQuantifiers > 3) return true;
            } else {
                consecutiveQuantifiers = 0;
            }
        }
        return false;
    }

    // --- Phase 1: json-path + decimal-eq ---

    /**
     * Compare two numbers with exact decimal precision, avoiding floating point errors.
     */
    public static boolean steleDecimalEq(Object a, Object b) {
        double left = assertNumber(a, "decimal-eq left");
        double right = assertNumber(b, "decimal-eq right");
        return String.format(java.util.Locale.US, "%.20f", left).equals(
               String.format(java.util.Locale.US, "%.20f", right));
    }

    /**
     * Extract a value from a JSON string using a simple JSON path expression.
     * Supports dot-separated keys and array indices (e.g., "foo.bar" or "foo[0]").
     */
    public static String steleJsonPath(Object data, Object pathExpr) {
        String dataStr = assertString(data, "json-path data");
        String pathStr = assertString(pathExpr, "json-path path");
        Object root = parseJson(dataStr);
        Object result = evalJsonPath(root, pathStr);
        if (result == null) return "";
        if (result instanceof Map || result instanceof List) {
            return toJsonString(result);
        }
        return String.valueOf(result);
    }

    private static Object evalJsonPath(Object data, String path) {
        if (path == null || path.isEmpty() || "$".equals(path)) return data;
        String p = path.startsWith("$") ? path.substring(1) : path;
        // Remove leading dot
        if (p.startsWith(".")) p = p.substring(1);
        if (p.isEmpty()) return data;

        int bracketIdx = -1;
        int dotIdx = -1;
        if (p.charAt(0) == '[') {
            bracketIdx = 0;
        } else {
            int i = 0;
            while (i < p.length() && p.charAt(i) != '.' && p.charAt(i) != '[') i++;
            String key = p.substring(0, i);
            if (data instanceof Map) {
                Object value = ((Map<?, Object>) data).get(key);
                String rest = p.substring(i);
                return evalJsonPath(value, rest);
            }
            return null;
        }

        // Array index
        int closeBracket = p.indexOf(']');
        if (closeBracket == -1) throw new SteleRuntimeError("json-path: unclosed bracket");
        String indexStr = p.substring(1, closeBracket);
        if ("*".equals(indexStr)) {
            // Wildcard - collect all matches into a list
            if (data instanceof List) {
                List<?> items = (List<?>) data;
                String rest = p.substring(closeBracket + 1);
                List<Object> results = new java.util.ArrayList<>();
                for (Object item : items) {
                    Object r = evalJsonPath(item, rest);
                    results.add(r != null ? r : null);
                }
                return results;
            }
            return new java.util.ArrayList<Object>();
        }
        int index = Integer.parseInt(indexStr);
        String rest = p.substring(closeBracket + 1);
        if (data instanceof List) {
            List<?> items = (List<?>) data;
            if (index >= 0 && index < items.size()) {
                return evalJsonPath(items.get(index), rest);
            }
        }
        return null;
    }

    private static Object parseJson(String json) {
        json = json.trim();
        if (json.startsWith("{")) return parseJsonObject(json);
        if (json.startsWith("[")) return parseJsonArray(json);
        if (json.startsWith("\"")) return json.substring(1, json.length() - 2);
        if ("true".equals(json)) return Boolean.TRUE;
        if ("false".equals(json)) return Boolean.FALSE;
        if ("null".equals(json)) return null;
        // Number
        try {
            if (json.contains(".")) return Double.parseDouble(json);
            return Long.parseLong(json);
        } catch (NumberFormatException e) {
            throw new SteleRuntimeError("json-path: invalid JSON: " + json);
        }
    }

    private static Map<String, Object> parseJsonObject(String json) {
        Map<String, Object> map = new LinkedHashMap<>();
        json = json.trim();
        if (!json.startsWith("{") || !json.endsWith("}")) {
            throw new SteleRuntimeError("json-path: invalid JSON object");
        }
        String inner = json.substring(1, json.length() - 1).trim();
        if (inner.isEmpty()) return map;
        int pos = 0;
        while (pos < inner.length()) {
            pos = skipWhitespace(inner, pos);
            if (pos >= inner.length() || inner.charAt(pos) != '"') break;
            int[] keyResult = extractJsonString(inner, pos);
            String key = inner.substring(keyResult[0] + 1, keyResult[1] - 1);
            pos = keyResult[1] + 1;
            pos = skipWhitespace(inner, pos);
            if (pos >= inner.length() || inner.charAt(pos) != ':') break;
            pos++;
            pos = skipWhitespace(inner, pos);
            int[] valueResult = extractJsonValue(inner, pos);
            String valueStr = inner.substring(pos, valueResult[0]);
            Object value = parseJson(valueStr);
            map.put(key, value);
            pos = valueResult[0] + 1;
            pos = skipWhitespace(inner, pos);
            if (pos < inner.length() && inner.charAt(pos) == ',') pos++;
        }
        return map;
    }

    private static List<Object> parseJsonArray(String json) {
        List<Object> list = new ArrayList<>();
        json = json.trim();
        if (!json.startsWith("[") || !json.endsWith("]")) {
            throw new SteleRuntimeError("json-path: invalid JSON array");
        }
        String inner = json.substring(1, json.length() - 1).trim();
        if (inner.isEmpty()) return list;
        int pos = 0;
        while (pos < inner.length()) {
            pos = skipWhitespace(inner, pos);
            if (pos >= inner.length()) break;
            int[] valueResult = extractJsonValue(inner, pos);
            String valueStr = inner.substring(pos, valueResult[0]);
            list.add(parseJson(valueStr));
            pos = valueResult[0] + 1;
            pos = skipWhitespace(inner, pos);
            if (pos < inner.length() && inner.charAt(pos) == ',') pos++;
        }
        return list;
    }

    private static int skipWhitespace(String s, int pos) {
        while (pos < s.length() && Character.isWhitespace(s.charAt(pos))) pos++;
        return pos;
    }

    private static int[] extractJsonString(String s, int pos) {
        // pos points to opening quote; find closing quote handling JSON escapes
        int i = pos + 1;
        while (i < s.length()) {
            char c = s.charAt(i);
            if (c == '"') return new int[]{pos, i};
            if (c == '\\') {
                i++;
                if (i < s.length() && s.charAt(i) == 'u') {
                    // \uXXXX — skip 4 hex digits
                    i += Math.min(4, Math.max(0, s.length() - i));
                } else if (i < s.length()) {
                    i++;
                }
                continue;
            }
            i++;
        }
        throw new SteleRuntimeError("json-path: unterminated string");
    }

    private static int[] extractJsonValue(String s, int pos) {
        char c = s.charAt(pos);
        if (c == '"') {
            return extractJsonString(s, pos);
        }
        if (c == '{') {
            return extractJsonBraced(s, pos, '{', '}');
        }
        if (c == '[') {
            return extractJsonBraced(s, pos, '[', ']');
        }
        // Number, true, false, null
        int i = pos;
        while (i < s.length() && s.charAt(i) != ',' && s.charAt(i) != '}' && s.charAt(i) != ']'
               && !Character.isWhitespace(s.charAt(i))) i++;
        return new int[]{i, i};
    }

    private static int[] extractJsonBraced(String s, int pos, char open, char close) {
        int depth = 1;
        int i = pos + 1;
        while (i < s.length() && depth > 0) {
            if (s.charAt(i) == '"') {
                int[] end = extractJsonString(s, i);
                i = end[1] + 1;
                continue;
            }
            if (s.charAt(i) == open) depth++;
            if (s.charAt(i) == close) depth--;
            if (depth > 0) i++;
        }
        return new int[]{i + 1, i + 1};
    }

    private static String toJsonString(Object value) {
        if (value == null) return "null";
        if (value instanceof String) return "\"" + ((String) value).replace("\\", "\\\\").replace("\"", "\\\"") + "\"";
        if (value instanceof Number || value instanceof Boolean) return String.valueOf(value);
        if (value instanceof Map) {
            Map<?, Object> map = (Map<?, Object>) value;
            StringBuilder sb = new StringBuilder("{");
            boolean first = true;
            for (Map.Entry<?, Object> entry : map.entrySet()) {
                if (!first) sb.append(",");
                sb.append("\"").append(entry.getKey().toString().replace("\"", "\\\"")).append("\":");
                sb.append(toJsonString(entry.getValue()));
                first = false;
            }
            sb.append("}");
            return sb.toString();
        }
        if (value instanceof List) {
            List<?> list = (List<?>) value;
            StringBuilder sb = new StringBuilder("[");
            boolean first = true;
            for (Object item : list) {
                if (!first) sb.append(",");
                sb.append(toJsonString(item));
                first = false;
            }
            sb.append("]");
            return sb.toString();
        }
        return String.valueOf(value);
    }

    private static String escapeJson(String value) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            switch (c) {
                case '"': sb.append("\\\""); break;
                case '\\': sb.append("\\\\"); break;
                case '\n': sb.append("\\n"); break;
                case '\r': sb.append("\\r"); break;
                case '\t': sb.append("\\t"); break;
                default:
                    if (c < 0x20) {
                        sb.append(String.format("\\u%04x", (int) c));
                    } else {
                        sb.append(c);
                    }
                    break;
            }
        }
        return sb.toString();
    }
}

/**
 * Test fixture helper that supplies the Stele assertion context.
 * Each generated test class calls this to obtain the shared Map<String, Object>
 * that the runtime evaluates invariants against.
 */
class SteleConftest {

    private static Map<String, Object> sContext = new LinkedHashMap<>();

    private SteleConftest() {}

    public static Map<String, Object> steleContext() {
        return sContext;
    }

    public static void setContext(Map<String, Object> context) {
        sContext = context;
    }
}

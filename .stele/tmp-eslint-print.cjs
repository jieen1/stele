let s='';
process.stdin.on('data', d => s += d);
process.stdin.on('end', () => {
  const data = JSON.parse(s);
  for (const r of data) {
    for (const m of r.messages || []) {
      console.log(`${m.ruleId || 'null'}\t${m.severity}\t${r.filePath}\t${m.line}:${m.column}\t${m.message}`);
    }
  }
});

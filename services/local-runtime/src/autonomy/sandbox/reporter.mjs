// Custom node:test reporter for the acceptance sandbox. It runs in the test runner's
// PARENT process, which executes no candidate code: the test file runs in a child
// process. Counts therefore come from structured runner events, never from text a
// child printed. Observed on the pinned runner (node 24): a child that exits before its
// root test completes flushes nothing, not even its earlier events, and the parent then
// reports only the file wrapper as passed. Completion is therefore the per-file
// `test:summary` the child emits when its root finishes; without it the file is not
// counted, so `process.exit(0)` inside candidate code cannot manufacture a pass.
// Limit: candidate code runs inside the same child as the tests; this protects against
// early exits and printed text, not against code that forges the runner's serialized
// event stream. The reviewer and approval rules cover that.
export default async function* factoryReporter(source) {
  const started = new Set();
  let pass = 0;
  let fail = 0;
  let skipped = 0;
  let todo = 0;
  let fileSummaries = 0;
  for await (const event of source) {
    const data = event.data ?? {};
    // The parent wraps the file in a test named by its path; that wrapper is not a test.
    const wrapper = data.nesting === 0 && data.name !== undefined && data.name === data.file;
    const key =
      data.name === undefined ? undefined : `${data.file}:${data.line}:${data.column}:${data.name}`;
    switch (event.type) {
      case 'test:start':
        if (key && !wrapper) started.add(key);
        break;
      case 'test:pass':
        if (wrapper) break;
        if (key) started.delete(key);
        if (data.skip !== undefined && data.skip !== false) skipped++;
        else if (data.todo !== undefined && data.todo !== false) todo++;
        else pass++;
        break;
      case 'test:fail':
        // A failed wrapper (child crashed or exited non-zero) is a failure of the file.
        if (key) started.delete(key);
        fail++;
        break;
      case 'test:summary':
        if (data.file !== undefined) fileSummaries++;
        break;
      default:
        break;
    }
  }
  yield `${JSON.stringify({
    version: 1,
    pass,
    fail,
    skipped,
    todo,
    unfinished: started.size,
    completed: fileSummaries === 1,
  })}\n`;
}

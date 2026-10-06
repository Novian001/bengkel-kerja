// WHY this file exists: on Node 22.23.3, `node --test backend/test/` does NOT recurse into the
// directory — the runner resolves the path as a module and fails with
// "Cannot find module '.../backend/test'". It accepts a directory only when that directory
// resolves through a package.json "main" (backend/test/package.json points here). So the
// command the spec asks for runs every test file below.
//
// It is an entry point, not a test: importing a test file is all it does, and node:test
// registers the tests as a side effect. Nothing lives here that is not an import, so
// `node --test` from the repo root (which discovers *.test.mjs itself) and
// `node --test backend/test/` (which lands here) run exactly the same 38 tests — verified, not
// assumed: without this file the dir form reports 1 failure, and with an index INSIDE test/ the
// root form double-counts every test.
import './backend/test/happy-path.test.mjs';
import './backend/test/state-machine.test.mjs';
import './backend/test/stock.test.mjs';
import './backend/test/bays.test.mjs';
import './backend/test/invoices.test.mjs';
import './backend/test/http.test.mjs';
import './backend/test/reports.test.mjs';

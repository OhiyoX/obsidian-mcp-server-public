// Keep the repository-root tool inventory regression inside the same full Node
// discovery that CI/release run through run-node-tests-ci.mjs.
//
// The imported suite performs the real in-process tools/list inventory checks;
// this wrapper exists only so app-level full discovery cannot silently omit the
// repository-root test file.
import "../../scripts/tool-inventory.test.mjs";

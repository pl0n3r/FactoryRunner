"""Aceptación ejecutable del typecheck TypeScript de FactoryRunner #4."""
from __future__ import annotations

import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def load_json(path: str) -> dict:
    return json.loads((ROOT / path).read_text(encoding="utf-8"))


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


class FactoryRunnerTypecheckContractTests(unittest.TestCase):
    def test_typescript_is_dev_only_and_pinned(self):
        package = load_json("package.json")
        lock = load_json("package-lock.json")

        self.assertNotIn("dependencies", package)
        self.assertEqual(
            package["devDependencies"],
            {
                "@types/node": "24.19.0",
                "typescript": "6.0.3",
            },
        )
        self.assertEqual(
            lock["packages"][""]["devDependencies"],
            package["devDependencies"],
        )
        self.assertEqual(
            lock["packages"]["node_modules/typescript"]["version"],
            "6.0.3",
        )
        self.assertEqual(
            lock["packages"]["node_modules/@types/node"]["version"],
            "24.19.0",
        )
        self.assertEqual(
            lock["packages"]["node_modules/undici-types"]["version"],
            "7.24.6",
        )

    def test_typecheck_script_runs_tsc_no_emit(self):
        package = load_json("package.json")
        self.assertEqual(package["scripts"]["typecheck"], "tsc --noEmit")

    def test_tsconfig_keeps_strict_type_contract(self):
        config = load_json("tsconfig.json")
        options = config["compilerOptions"]
        self.assertTrue(options["strict"])
        self.assertTrue(options["noEmit"])
        self.assertTrue(options["allowImportingTsExtensions"])
        self.assertTrue(options["erasableSyntaxOnly"])
        self.assertTrue(options["verbatimModuleSyntax"])
        self.assertEqual(options["module"], "NodeNext")
        self.assertEqual(options["moduleResolution"], "NodeNext")
        self.assertEqual(options["types"], ["node"])

    def test_node_ci_requires_typecheck(self):
        workflow = read(".github/workflows/ci.yml")
        self.assertIn("node-typecheck:", workflow)
        self.assertIn("npm run typecheck", workflow)
        self.assertIn(
            "python3 -m unittest discover -s tests -p 'test_*.py'",
            workflow,
        )
        self.assertIn("npm ci --ignore-scripts --no-audit --no-fund", workflow)
        self.assertIn(
            "needs: [ci, node-typecheck, node-main, release-version]",
            workflow,
        )

    def test_runtime_scripts_and_dependencies_remain_safe(self):
        package = load_json("package.json")
        self.assertEqual(
            package["scripts"]["test"],
            "node --experimental-strip-types --test tests/*.test.ts",
        )
        self.assertEqual(
            package["scripts"]["build"],
            "node --experimental-strip-types scripts/build.ts",
        )
        self.assertNotIn("dependencies", package)
        self.assertEqual(package["engines"]["node"], ">=24")


if __name__ == "__main__":
    unittest.main()

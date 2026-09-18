import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / "infra/valhalla/prepare_regions.py"
spec = importlib.util.spec_from_file_location("prepare_regions", SCRIPT)
regions = importlib.util.module_from_spec(spec)
spec.loader.exec_module(regions)


class RegionalInputTests(unittest.TestCase):
    def test_build_merges_inputs_once_and_preserves_existing_aragon(self):
        with tempfile.TemporaryDirectory() as folder:
            base = Path(folder)
            legacy = base / "aragon.osm.pbf"
            legacy.write_bytes(b"legacy")

            def run(command, **kwargs):
                self.assertTrue(kwargs["check"])
                Path(command[command.index("--output") + 1]).write_bytes(b"complete")

            with patch.object(regions.subprocess, "run", side_effect=run) as commands:
                merged = regions.prepare(base)
                self.assertEqual(commands.call_count, 4)
                merge = commands.call_args.args[0]
                self.assertEqual(merge[:2], ["osmium", "merge"])
                self.assertEqual(len(list(merged.parent.glob("*.pbf"))), 1)
                self.assertEqual(legacy.read_bytes(), b"legacy")
                regions.prepare(base)
                self.assertEqual(commands.call_count, 4, "restart reuses cached data")

    def test_failed_download_does_not_publish_incomplete_source(self):
        with tempfile.TemporaryDirectory() as folder:
            base = Path(folder)

            def fail(command, **kwargs):
                Path(command[command.index("--output") + 1]).write_bytes(b"partial")
                raise subprocess.CalledProcessError(1, command)

            with patch.object(regions.subprocess, "run", side_effect=fail):
                with self.assertRaises(subprocess.CalledProcessError):
                    regions.prepare(base)
            self.assertFalse((base / "sources-es-panama-v1/spain.osm.pbf").exists())
            self.assertFalse((base / "es-panama-v1/es-panama.osm.pbf").exists())

    def test_failed_merge_is_retried_without_redownloading_sources(self):
        with tempfile.TemporaryDirectory() as folder:
            base = Path(folder)

            def run(command, **kwargs):
                Path(command[command.index("--output") + 1]).write_bytes(b"data")
                if command[0] == "osmium":
                    raise subprocess.CalledProcessError(1, command)

            with patch.object(regions.subprocess, "run", side_effect=run):
                with self.assertRaises(subprocess.CalledProcessError):
                    regions.prepare(base)
            self.assertFalse((base / "es-panama-v1/es-panama.osm.pbf").exists())

            def finish(command, **kwargs):
                self.assertEqual(command[0], "osmium")
                Path(command[command.index("--output") + 1]).write_bytes(b"merged")

            with patch.object(regions.subprocess, "run", side_effect=finish) as commands:
                self.assertTrue(regions.prepare(base).exists())
                self.assertEqual(commands.call_count, 1)

    def test_dataset_paths_cannot_escape_persistent_directory(self):
        with tempfile.TemporaryDirectory() as folder:
            for name in ["../aragon", "/tmp/data", "", "es-panama-v0"]:
                with self.assertRaises(ValueError):
                    regions.prepare(Path(folder), name)


if __name__ == "__main__":
    unittest.main()

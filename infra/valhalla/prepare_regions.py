"""Prepare one merged OSM input, cached on the existing persistent disk."""
import os
from pathlib import Path
import re
import subprocess
import sys

SOURCES = {
    "spain": "https://download.geofabrik.de/europe/spain-latest.osm.pbf",
    "canary-islands": "https://download.geofabrik.de/africa/canary-islands-latest.osm.pbf",
    "panama": "https://download.geofabrik.de/central-america/panama-latest.osm.pbf",
}


def prepare(base=Path("/custom_files"), dataset="es-panama-v1"):
    if not re.fullmatch(r"es-panama-v[1-9][0-9]*", dataset):
        raise ValueError("path_extension must be es-panama-v1, es-panama-v2, etc.")
    target = base / dataset
    target.mkdir(parents=True, exist_ok=True)
    merged = target / "es-panama.osm.pbf"
    if merged.is_file() and merged.stat().st_size > 0:
        print(f"[VALHALLA] Reusing regional input: {merged}", flush=True)
        return merged
    # Keep original extracts outside the directory scanned by Valhalla. Older
    # Aragon tiles and inputs in /custom_files are preserved for rollback.
    sources = base / f"sources-{dataset}"
    sources.mkdir(parents=True, exist_ok=True)
    inputs = []
    for name, url in SOURCES.items():
        source = sources / f"{name}.osm.pbf"
        if not source.is_file() or source.stat().st_size == 0:
            partial = source.with_suffix(".partial")
            print(f"[VALHALLA] Downloading {name}", flush=True)
            subprocess.run(["curl", "--fail", "--location", "--silent", "--show-error",
                            "--retry", "3", "--connect-timeout", "15", "--max-time", "1800",
                            "--output", str(partial), url], check=True)
            partial.replace(source)
        inputs.append(str(source))
    partial = target / "es-panama.partial.osm.pbf"
    print("[VALHALLA] Merging Spain, Canary Islands and Panama", flush=True)
    subprocess.run(["osmium", "merge", *inputs, "--overwrite", "--output", str(partial)],
                   check=True)
    if not partial.is_file() or partial.stat().st_size == 0:
        raise RuntimeError("OSM merge produced no data")
    partial.replace(merged)
    return merged


def main():
    dataset = os.environ.get("path_extension") or "es-panama-v1"
    prepare(dataset=dataset)
    os.environ["path_extension"] = dataset
    os.environ["tile_urls"] = ""
    os.environ["use_tiles_ignore_pbf"] = "False"
    # The original entrypoint builds and serves the graph using one PBF.
    os.execv("/valhalla/scripts/docker-entrypoint.sh",
             ["/valhalla/scripts/docker-entrypoint.sh", *(sys.argv[1:] or ["build_tiles"])])


if __name__ == "__main__":
    main()

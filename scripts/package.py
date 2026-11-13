"""Build only runtime files; exclude tests, dependencies, screenshots and credentials."""
from pathlib import Path
import json
import zipfile

root = Path(__file__).resolve().parent.parent
manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
output = root / f"plato-enhanced-{manifest['version']}.zip"
files = [root / name for name in ["manifest.json", "options.html", "options.js", "README.md"]]
for folder in ["src", "styles", "weekly", "assets"]:
    files.extend(sorted((root / folder).rglob("*")))
with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
    for file in files:
        if file.is_file():
            archive.write(file, file.relative_to(root).as_posix())
with zipfile.ZipFile(output) as archive:
    assert archive.testzip() is None
print(f"Created {output.name} ({output.stat().st_size:,} bytes)")

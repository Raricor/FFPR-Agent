"""Pack deploy/laptop into dist/ffpr-laptop-setup.zip, for copying to the laptop by hand.

Needed once, before SSH works; afterwards `ffpr-laptop deploy` keeps the laptop in sync.
"""

import sys
import zipfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SOURCE = REPO / "deploy" / "laptop"
OUT = REPO / "dist" / "ffpr-laptop-setup.zip"


def main() -> int:
    OUT.parent.mkdir(exist_ok=True)
    with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED) as z:
        for path in sorted(SOURCE.rglob("*")):
            if path.is_file():
                z.write(path, Path("ffpr-laptop-setup") / path.relative_to(SOURCE))
    print(OUT)
    return 0


if __name__ == "__main__":
    sys.exit(main())

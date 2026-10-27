.PHONY: check lint test fmt check-scripts laptop-bundle

check: lint test check-scripts

lint:
	uv run ruff check .
	uv run ruff format --check .

test:
	uv run pytest

fmt:
	uv run ruff format .
	uv run ruff check --fix .

# Windows PowerShell 5.1 reads BOM-less scripts in the ANSI code page, which garbles Chinese text.
# Every .ps1/.psm1 must therefore start with a UTF-8 BOM. Scripts are also parsed with pwsh if present.
check-scripts:
	uv run python tools/check_ps_scripts.py deploy/laptop

laptop-bundle:
	uv run python tools/bundle_laptop.py

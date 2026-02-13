PYTHON := .venv/bin/python

.PHONY: extract validate summarize checksums sync-data test all clean

extract:
	$(PYTHON) scripts/extract_data.py

validate:
	$(PYTHON) scripts/validate_data.py

summarize:
	$(PYTHON) scripts/summarize_data.py

checksums:
	$(PYTHON) scripts/write_checksums.py

sync-data:
	$(PYTHON) scripts/sync_app_data.py

# Unit tests are stdlib unittest to avoid hidden dependency drift.
test:
	$(PYTHON) -m unittest discover -s tests -p 'test_*.py' -v

all: extract validate summarize checksums sync-data test

clean:
	rm -rf data/interim/* data/processed/* docs/data

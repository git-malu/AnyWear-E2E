---
name: pdf
description: Read and extract text content from PDF files using pdfplumber (Python)
license: MIT
compatibility: opencode
metadata:
  audience: developers
  workflow: file-reading
---

## What I do

- Locate PDF files in the repository using glob patterns (e.g., `**/*.pdf`).
- Extract text content from PDFs using `pdfplumber` (Python library).
- Handle multi-page PDFs, paginate through large documents, and extract tables.
- Summarize extracted content for use in design, documentation, or code tasks.

## When to use me

Use this when the user asks to read, inspect, or extract information from a PDF file, or when a task references content in a PDF document.

## Prerequisites

Ensure `pdfplumber` is installed:

```bash
pip install pdfplumber
```

## Usage

### Step 1: Locate PDF Files

If the PDF path is unknown, search for it:

```
Glob: **/*.pdf
```

### Step 2: Extract All Text from the PDF

Use Python with `pdfplumber`. Set `PYTHONIOENCODING=utf-8` to handle Unicode characters in the output:

```bash
$env:PYTHONIOENCODING='utf-8'; python -c "
import pdfplumber, sys
path = sys.argv[1]
with pdfplumber.open(path) as pdf:
    print(f'Pages: {len(pdf.pages)}')
    for i, page in enumerate(pdf.pages):
        text = page.extract_text()
        if text:
            print(f'\\n<<< PAGE {i+1} / {len(pdf.pages)} >>>\\n')
            print(text)
" '<absolute-path-to-pdf>'
```

### Step 3: Extract a Specific Page Range

For large PDFs, specify `start` and `end` page numbers (1-indexed):

```bash
$env:PYTHONIOENCODING='utf-8'; python -c "
import pdfplumber, sys
path, start, end = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
with pdfplumber.open(path) as pdf:
    for i in range(start - 1, min(end, len(pdf.pages))):
        text = pdf.pages[i].extract_text()
        if text:
            print(f'\\n<<< PAGE {i+1} / {len(pdf.pages)} >>>\\n')
            print(text)
" '<path>' <start> <end>
```

### Step 4: Find a PDF by Glob and Extract (Combined)

```bash
$env:PYTHONIOENCODING='utf-8'; $file = Get-ChildItem -Path '<search-dir>' -Filter '*.pdf' -Recurse | Select-Object -First 1; python -c "
import pdfplumber, sys
with pdfplumber.open(sys.argv[1]) as pdf:
    print(f'Pages: {len(pdf.pages)}')
    for i, page in enumerate(pdf.pages):
        text = page.extract_text()
        if text:
            print(f'\\n<<< PAGE {i+1} >>>\\n' + text)
" $file.FullName
```

### Step 5: Extract Tables from a PDF

If the PDF contains tabular data:

```bash
$env:PYTHONIOENCODING='utf-8'; python -c "
import pdfplumber, sys, itertools
with pdfplumber.open(sys.argv[1]) as pdf:
    for pi, page in enumerate(pdf.pages):
        tables = page.extract_tables()
        for ti, table in enumerate(tables):
            print(f'\\n--- Table in Page {pi+1} ---')
            for row in table:
                print(' | '.join([c or '' for c in row]))
" '<path>'
```

### Step 6: Summarize

After extracting, synthesize the key information relevant to the task. Strip boilerplate (legal notices, page headers/footers) and focus on the substantive content.

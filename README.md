# TestForge – AI Test Case Generator

> **IBM Bob Capstone · IT – AI Agent for Programming**  
> A single-page, fully offline test case generator that turns plain-language software requirements into structured, categorised test cases.

---

## How to Run

1. **Download / clone** all three files into the same folder:
   ```
   index.html
   style.css
   app.js
   ```
2. **Open `index.html`** in any modern browser (Chrome 90+, Firefox 88+, Edge 90+, Safari 15+).  
   No build step. No server. No internet connection required.
3. That's it — the app runs entirely in the browser.

> **Tip:** On Windows you can simply double-click `index.html`.  
> On macOS, right-click → *Open With → Your Browser*.

---

## Features

| Feature | Details |
|---------|---------|
| **Input Panel** | Textarea for any user story/requirement + feature-type dropdown (Login, Registration, Form Input, Search, Payment, Other) |
| **Quick Examples** | Three one-click example buttons (Login, Registration, Search) that pre-fill the textarea |
| **AI Rule Engine** | NLP-style extraction of fields, formats (email, password, date, URL…), constraints (min/max length, unique, required, match, age, attempts, lock duration, XSS, whitespace) |
| **4 Test Categories** | Positive · Negative · Boundary · Edge Case |
| **Rich Test Cases** | Every case has: ID (TC-001…), title, category, priority (High/Medium/Low), preconditions, numbered steps, test data, and expected result |
| **Summary Bar** | Live badge count per category, updates when filters change |
| **Filter Bar** | Filter by category AND priority simultaneously; Clear Filters button |
| **Export CSV** | Downloads a UTF-8 BOM CSV file (Excel-friendly) with all test cases |
| **Export Markdown** | Copies a fully-formatted Markdown document to the clipboard (grouped by category, with summary table) |
| **Empty State** | Friendly prompt shown before any generation |
| **Error State** | Inline error with fix instruction when input is blank or too short (<30 chars) |
| **Responsive** | CSS Grid layout; single-column at ≤900px; tested down to 360px width |
| **Accessible** | WCAG AA contrast ratios, visible keyboard focus rings, semantic HTML, ARIA labels, `aria-live` regions |
| **Zero dependencies** | HTML5 + CSS3 + Vanilla JS only. No frameworks, no libraries, no API keys, no network requests |

---

## Sample Inputs

### 1 – Login

**Feature Type:** Login

```
As a registered user, I want to log in to the application using my email address
and password so that I can access my personal dashboard.

Constraints:
- Email must be a valid format (e.g. user@example.com)
- Password must be at least 8 characters and no more than 64 characters
- Both fields are required
- After 5 failed attempts the account must be locked for 15 minutes
- A "Remember me" checkbox keeps the session for 30 days
```

**Expected output:** ~15 test cases covering happy path, wrong password, unregistered email,
locked account, "Remember Me" persistence, session expiry, SQL injection, XSS, whitespace-only
input, double submission, and more.

---

### 2 – Registration

**Feature Type:** Registration

```
As a new visitor, I want to register for an account so that I can use the platform's features.

Constraints:
- Username: 3–20 characters, alphanumeric and underscores only, must be unique
- Email: valid email format, must not already be registered
- Password: 8–64 characters, must contain at least one uppercase letter,
  one number, and one special character
- Confirm password field must match the password field
- User must accept the Terms & Conditions checkbox (required)
- Date of birth: user must be at least 18 years old
```

**Expected output:** ~20 test cases including username too short/long, invalid characters in
username, duplicate email, password complexity failures, confirm-password mismatch, unchecked
T&C, age boundary (exactly 18 years, one day under 18), SQL injection, XSS, and Unicode.

---

### 3 – Search

**Feature Type:** Search

```
As a user, I want to search for products by keyword so that I can quickly find what I need.

Constraints:
- Search input accepts 1–100 characters
- Input must be trimmed (leading/trailing whitespace ignored)
- Special characters (<, >, ", ') must be sanitised to prevent XSS
- Returns up to 50 results per page
- If no results found, a friendly "No results" message is shown
- Search is case-insensitive
```

**Expected output:** ~15 test cases including successful search, no-results message, empty
query, 1-char (minimum boundary), 100-char (maximum boundary), 101-char (over limit), whitespace
trimming, XSS/script injection, SQL injection, case-insensitive variants, and 50-result limit.

---

## File Structure

```
├── index.html   – Semantic markup, ARIA, structure
├── style.css    – CSS custom properties, Grid, responsive, WCAG AA
├── app.js       – Rule engine, generation, rendering, filter, export
└── README.md    – This file
```

---

## Architecture Notes

```
app.js
 ├── extractConstraints(text)       ← NLP: mines min/maxLength, formats, rules from text
 ├── detectFields(text)             ← Identifies field names (email, password, username…)
 ├── generateTestCases(...)         ← Orchestrator: calls generic + feature-specific rules
 │    ├── getGenericCases()         ← Constraint-driven cases (boundary, empty, injection…)
 │    ├── getFeatureSpecificCases() ← Login / Registration / Search / Payment / Form rules
 │    ├── ensureAllCategories()     ← Guarantees all 4 categories exist
 │    ├── deduplicateCases()        ← Removes same-title duplicates
 │    └── assignIds()               ← TC-001… sorted by category then priority
 ├── renderResults()                ← Summary bar + table HTML generation
 ├── applyFilters()                 ← Live category + priority filter
 ├── exportCsv()                    ← Blob → download link
 └── exportMarkdown()               ← Clipboard API with textarea fallback
```

---

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Ctrl + Enter` (in textarea) | Generate test cases |
| `Tab` | Navigate between all interactive controls |

---

## Browser Compatibility

| Browser | Min Version |
|---------|------------|
| Chrome / Edge | 90+ |
| Firefox | 88+ |
| Safari | 15+ |

> The Clipboard API (`navigator.clipboard.writeText`) may require a user gesture in some browsers. A `document.execCommand` fallback is included for compatibility.

---

*Built for the IBM Bob Capstone – IT, AI Agent for Programming track.*

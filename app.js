/**
 * =============================================================
 * TESTFORGE – app.js
 * AI Test Case Generator (rule-based, fully offline)
 * IBM Bob Capstone · IT – AI Agent for Programming
 * =============================================================
 *
 * Sections:
 *  1.  Constants & example requirements
 *  2.  DOM references
 *  3.  Event wiring
 *  4.  NLP extraction helpers
 *  5.  Test case generation engine
 *  6.  Feature-specific rule sets
 *  7.  Renderer (table + summary)
 *  8.  Filter logic
 *  9.  Export: CSV
 * 10.  Export: Markdown (copy to clipboard)
 * 11.  Toast notifications
 * 12.  Utility helpers
 * =============================================================
 */

'use strict';

/* ============================================================
   1. CONSTANTS & EXAMPLE REQUIREMENTS
   ============================================================ */

const EXAMPLES = {
  login: {
    featureType: 'Login',
    text: `As a registered user, I want to log in to the application using my email address and password so that I can access my personal dashboard.

Constraints:
- Email must be a valid format (e.g. user@example.com)
- Password must be at least 8 characters and no more than 64 characters
- Both fields are required
- After 5 failed attempts the account must be locked for 15 minutes
- A "Remember me" checkbox keeps the session for 30 days`
  },

  registration: {
    featureType: 'Registration',
    text: `As a new visitor, I want to register for an account so that I can use the platform's features.

Constraints:
- Username: 3–20 characters, alphanumeric and underscores only, must be unique
- Email: valid email format, must not already be registered
- Password: 8–64 characters, must contain at least one uppercase letter, one number, and one special character
- Confirm password field must match the password field
- User must accept the Terms & Conditions checkbox (required)
- Date of birth: user must be at least 18 years old`
  },

  search: {
    featureType: 'Search',
    text: `As a user, I want to search for products by keyword so that I can quickly find what I need.

Constraints:
- Search input accepts 1–100 characters
- Input must be trimmed (leading/trailing whitespace ignored)
- Special characters (<, >, ", ') must be sanitised to prevent XSS
- Returns up to 50 results per page
- If no results found, a friendly "No results" message is shown
- Search is case-insensitive`
  }
};

/** Canonical category order used throughout the app */
const CATEGORIES = ['Positive', 'Negative', 'Boundary', 'Edge Case'];

/** Priority weights (higher = more important for ordering) */
const PRIORITY_WEIGHT = { High: 3, Medium: 2, Low: 1 };

/** Minimum requirement length to attempt generation */
const MIN_REQ_LENGTH = 30;


/* ============================================================
   2. DOM REFERENCES
   ============================================================ */

const dom = {
  featureType:       document.getElementById('featureType'),
  requirementInput:  document.getElementById('requirementInput'),
  reqError:          document.getElementById('req-error'),
  generateBtn:       document.getElementById('generateBtn'),

  emptyState:        document.getElementById('emptyState'),
  resultsContent:    document.getElementById('resultsContent'),
  summaryBar:        document.getElementById('summaryBar'),
  testCasesBody:     document.getElementById('testCasesBody'),
  noFilterMatch:     document.getElementById('noFilterMatch'),

  filterCategory:    document.getElementById('filterCategory'),
  filterPriority:    document.getElementById('filterPriority'),
  clearFiltersBtn:   document.getElementById('clearFiltersBtn'),
  clearFiltersBtn2:  document.getElementById('clearFiltersBtn2'),

  exportCsvBtn:      document.getElementById('exportCsvBtn'),
  exportMdBtn:       document.getElementById('exportMdBtn'),
  toast:             document.getElementById('toast'),
};

/** Holds the currently generated test cases (full set, unfiltered) */
let allTestCases = [];


/* ============================================================
   3. EVENT WIRING
   ============================================================ */

/** Wire up all interactive elements once the DOM is ready */
(function initEvents() {
  // Generate button
  dom.generateBtn.addEventListener('click', handleGenerate);

  // Allow Ctrl+Enter inside textarea to trigger generation
  dom.requirementInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      handleGenerate();
    }
  });

  // Clear error styling as user types
  dom.requirementInput.addEventListener('input', () => {
    clearInputError();
  });

  // Example buttons
  document.querySelectorAll('.btn-example').forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.example;
      if (EXAMPLES[key]) {
        dom.requirementInput.value = EXAMPLES[key].text;
        dom.featureType.value = EXAMPLES[key].featureType;
        clearInputError();
        dom.requirementInput.focus();
      }
    });
  });

  // Filters
  dom.filterCategory.addEventListener('change', applyFilters);
  dom.filterPriority.addEventListener('change', applyFilters);

  // Clear filter buttons (two: in filter bar + no-match message)
  dom.clearFiltersBtn.addEventListener('click', clearFilters);
  dom.clearFiltersBtn2.addEventListener('click', clearFilters);

  // Export buttons
  dom.exportCsvBtn.addEventListener('click', exportCsv);
  dom.exportMdBtn.addEventListener('click', exportMarkdown);
})();


/* ============================================================
   4. NLP EXTRACTION HELPERS
   ============================================================ */

/**
 * parseFieldConstraints()
 * Splits the requirement text into individual constraint lines and parses
 * each one into a structured FieldDescriptor.  Lines that start with a
 * recognised field label (e.g. "Username: 3–20 characters…") produce a named
 * field entry; other lines contribute to a shared global object.
 *
 * Returns: { fields: FieldDescriptor[], global: GlobalConstraints }
 *
 * FieldDescriptor:
 *   name, minLength, maxLength, isEmail, isPassword, isDate,
 *   isConfirm, isCheckbox, isRequired, mustBeUnique, minAge,
 *   alphanumeric, noSpecialChars, hasComplexity
 */
function parseFieldConstraints(text) {
  const global = {
    maxAttempts:     null,
    lockDuration:    null,
    maxResults:      null,
    specialChars:    false,
    caseInsensitive: false,
    trimmed:         false,
    mustAgree:       false,
    hasRememberMe:   false,
  };

  // Canonical map: regex matched against the start of each line → display name.
  // Ordered longest/most-specific first to avoid shadowing (Confirm Password
  // must come before Password).
  const FIELD_LABEL_MAP = [
    [/\bconfirm\s+password\b/,              'Confirm Password'],
    [/\bdate\s+of\s+birth\b|\bdob\b/,       'Date of Birth'],
    [/\bpassword\b/,                         'Password'],
    [/\bemail\b/,                            'Email'],
    [/\busername\b/,                         'Username'],
    [/\bphone\b|\bmobile\b/,                'Phone Number'],
    [/\bfirst\s+name\b/,                    'First Name'],
    [/\blast\s+name\b/,                     'Last Name'],
    [/\bfull\s+name\b/,                     'Full Name'],
    [/\bsearch\b|\bkeyword\b|\bquery\b/,    'Search Query'],
    [/\burl\b|\bwebsite\b/,                 'URL'],
    [/\bcard\s+number\b|\bcredit\s+card\b/, 'Card Number'],
    [/\bcvv\b|\bcvc\b/,                     'CVV'],
    [/\bamount\b|\bprice\b/,                'Amount'],
    [/\bterms\b|\bconditions\b|\bcheckbox\b|\bagree\b|\baccept\b/, 'Terms Checkbox'],
    [/\bremember\s+me\b/,                   'Remember Me'],
  ];

  /** Build a FieldDescriptor from one constraint line. */
  function parseSingleLine(line, label) {
    const t = line.toLowerCase();
    const fd = {
      name:           label || '',
      minLength:      null,
      maxLength:      null,
      isEmail:        false,
      isPassword:     label ? /password/i.test(label)              : false,
      isDate:         label ? /date|birth|dob/i.test(label)        : false,
      isConfirm:      label ? /confirm/i.test(label)               : false,
      isCheckbox:     label ? /terms|checkbox|agree|accept/i.test(label) : false,
      isRequired:     false,
      mustBeUnique:   false,
      minAge:         null,
      alphanumeric:   false,
      noSpecialChars: false,
      hasComplexity:  false,
    };

    // Length: "N–M chars" or "N to M chars"
    const rangeM = t.match(/(\d+)\s*(?:–|-|to)\s*(\d+)\s*char/);
    if (rangeM) { fd.minLength = parseInt(rangeM[1], 10); fd.maxLength = parseInt(rangeM[2], 10); }

    // Length: "at least N / minimum N characters"
    const minM = t.match(/(?:at least|minimum|min)\s+(\d+)\s*char/);
    if (minM) fd.minLength = parseInt(minM[1], 10);

    // Length: "no more than N / maximum N / up to N characters"
    const maxM = t.match(/(?:no more than|maximum|max|up to)\s+(\d+)\s*char/);
    if (maxM) fd.maxLength = parseInt(maxM[1], 10);

    // Length: "exactly N characters"
    const exactM = t.match(/exactly\s+(\d+)\s*char/);
    if (exactM) { fd.minLength = parseInt(exactM[1], 10); fd.maxLength = fd.minLength; }

    // Format
    if (/\bvalid\s+email\b|\bemail\s+format\b|\bemail\b/.test(t)) fd.isEmail = true;

    // Rules
    if (/\brequired\b|\bmandatory\b|\bmust\s+(?:not\s+be\s+)?(?:empty|blank)\b/.test(t)) fd.isRequired = true;
    if (/\bunique\b|\bnot\s+already\b|\bnot\s+taken\b/.test(t))   fd.mustBeUnique = true;
    if (/\b(?:confirm|match|same\s+as)\b/.test(t))                fd.isConfirm    = true;
    if (/\bterms\b|\bconditions\b|\bcheckbox\b|\bagree\b|\baccept\b/.test(t)) fd.isCheckbox = true;

    // Character rules
    if (/alphanumeric|letters.*numbers|numbers.*letters/.test(t)) fd.alphanumeric  = true;
    if (/no\s+special|only\s+letters|only\s+alpha|underscores?\s+only/.test(t)) fd.noSpecialChars = true;

    // Password complexity
    if (/uppercase|upper\s+case|capital|special\s+char|one\s+number|one\s+digit/.test(t)) fd.hasComplexity = true;

    // Age
    const ageM = t.match(/(?:at least|minimum)\s+(\d+)\s*years?\s*old/);
    if (ageM) fd.minAge = parseInt(ageM[1], 10);

    return fd;
  }

  const fieldMap = new Map(); // display name → FieldDescriptor

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/^[\s\-*•]+/, '').trim(); // strip bullets
    if (!line) continue;
    const t = line.toLowerCase();

    // ── Accumulate global flags ──
    const attM = t.match(/(\d+)\s*failed\s*attempts/);
    if (attM) global.maxAttempts = parseInt(attM[1], 10);
    const lockM = t.match(/locked?\s+(?:for\s+)?(\d+)\s*min/);
    if (lockM) global.lockDuration = parseInt(lockM[1], 10);
    const resM = t.match(/up\s+to\s+(\d+)\s*results/);
    if (resM) global.maxResults = parseInt(resM[1], 10);
    if (/saniti[sz]|xss|special\s+char|escape|strip/.test(t))  global.specialChars    = true;
    if (/case.insensitive/.test(t))                             global.caseInsensitive = true;
    if (/\btrim(med)?\b|\bleading.trailing\b|\bwhitespace\b/.test(t)) global.trimmed  = true;
    if (/\bterms\b|\bconditions\b|\bcheckbox\b|\bagree\b|\baccept\b/.test(t)) global.mustAgree = true;
    if (/\bremember\s*me\b/.test(t))                            global.hasRememberMe   = true;

    // ── Detect field label in the first 40 chars of the line ──
    let detectedLabel = null;
    const head = t.slice(0, 40);
    for (const [pattern, displayName] of FIELD_LABEL_MAP) {
      if (pattern.test(head)) { detectedLabel = displayName; break; }
    }

    if (!detectedLabel) continue;

    const fd = parseSingleLine(line, detectedLabel);

    if (fieldMap.has(detectedLabel)) {
      // Merge: take the more-specific (non-null) value for scalars; OR for booleans
      const ex = fieldMap.get(detectedLabel);
      if (fd.minLength !== null) ex.minLength = fd.minLength;
      if (fd.maxLength !== null) ex.maxLength = fd.maxLength;
      if (fd.minAge    !== null) ex.minAge    = fd.minAge;
      ex.isRequired    = ex.isRequired    || fd.isRequired;
      ex.mustBeUnique  = ex.mustBeUnique  || fd.mustBeUnique;
      ex.isEmail       = ex.isEmail       || fd.isEmail;
      ex.alphanumeric  = ex.alphanumeric  || fd.alphanumeric;
      ex.noSpecialChars= ex.noSpecialChars|| fd.noSpecialChars;
      ex.hasComplexity = ex.hasComplexity || fd.hasComplexity;
      ex.isConfirm     = ex.isConfirm     || fd.isConfirm;
      ex.isCheckbox    = ex.isCheckbox    || fd.isCheckbox;
    } else {
      fieldMap.set(detectedLabel, fd);
    }
  }

  // Fallback: if no named fields found, scan the whole text
  if (fieldMap.size === 0) {
    const fallback = [
      [/\bconfirm\s+password\b/,           'Confirm Password'],
      [/\bemail\b/,                         'Email'],
      [/\bpassword\b/,                      'Password'],
      [/\busername\b/,                      'Username'],
      [/\bdate\s+of\s+birth\b|\bdob\b/,    'Date of Birth'],
      [/\bsearch\b|\bkeyword\b|\bquery\b/, 'Search Query'],
    ];
    const wt = text.toLowerCase();
    for (const [pattern, label] of fallback) {
      if (pattern.test(wt) && !fieldMap.has(label)) {
        fieldMap.set(label, parseSingleLine(text, label));
      }
    }
  }

  return { fields: Array.from(fieldMap.values()), global };
}

/**
 * extractConstraints()
 * Derives the flat legacy constraint object from parseFieldConstraints()
 * so every existing helper continues to work without modification.
 *
 * @param {string} text
 * @returns {Object}
 */
function extractConstraints(text) {
  const { fields, global } = parseFieldConstraints(text);
  const t = text.toLowerCase();

  let minLength = null;
  let maxLength = null;
  for (const f of fields) {
    if (f.minLength !== null && (minLength === null || f.minLength < minLength)) minLength = f.minLength;
    if (f.maxLength !== null && (maxLength === null || f.maxLength > maxLength)) maxLength = f.maxLength;
  }

  return {
    minLength,
    maxLength,
    exactLength:     null,
    hasEmail:        fields.some(f => f.isEmail)    || /\bemail\b/.test(t),
    hasPassword:     fields.some(f => f.isPassword) || /\bpassword\b/.test(t),
    hasDate:         fields.some(f => f.isDate)     || /\bdate\b|\bbirthday\b|\bdob\b/.test(t),
    hasPhone:        /\bphone\b|\bmobile\b/.test(t),
    hasUrl:          /\burl\b|\bwebsite\b/.test(t),
    hasUsername:     fields.some(f => /username/i.test(f.name)),
    isRequired:      fields.some(f => f.isRequired) || /\brequired\b/.test(t),
    mustMatch:       fields.some(f => f.isConfirm)  || /\bconfirm\b|\bmatch\b/.test(t),
    mustBeUnique:    fields.some(f => f.mustBeUnique),
    mustAgree:       global.mustAgree,
    minAge:          fields.reduce((a, f) => f.minAge !== null ? f.minAge : a, null),
    maxResults:      global.maxResults,
    maxAttempts:     global.maxAttempts,
    lockDuration:    global.lockDuration,
    specialChars:    global.specialChars,
    caseInsensitive: global.caseInsensitive,
    trimmed:         global.trimmed,
    rawMentions:     [],
  };
}

/**
 * detectFields()
 * Returns field display names from parseFieldConstraints first,
 * then falls back to a pattern scan for unstructured text.
 *
 * @param {string} text
 * @returns {string[]}
 */
function detectFields(text) {
  const { fields } = parseFieldConstraints(text);
  if (fields.length > 0) return fields.map(f => f.name);

  const t = text.toLowerCase();
  const result = [];
  const map = [
    ['Email',            /\bemail\b/],
    ['Password',         /\bpassword\b/],
    ['Username',         /\busername\b/],
    ['Confirm Password', /\bconfirm\s+password\b/],
    ['Date of Birth',    /\bdate of birth\b|\bdob\b|\bbirthday\b/],
    ['Phone Number',     /\bphone\b|\bmobile\b/],
    ['Search Query',     /\bsearch\b|\bkeyword\b|\bquery\b/],
    ['URL',              /\burl\b|\bwebsite\b/],
    ['Card Number',      /\bcard\s*number\b|\bcredit\s*card\b/],
    ['CVV',              /\bcvv\b|\bcvc\b/],
    ['Amount',           /\bamount\b|\bprice\b/],
    ['Remember Me',      /\bremember\s*me\b/],
    ['Terms Checkbox',   /\bterms\b.*\bcheckbox\b|\bcheckbox\b.*\bterms\b/],
  ];
  for (const [label, pattern] of map) {
    if (pattern.test(t)) result.push(label);
  }
  return result.length > 0 ? result : ['input field'];
}


/* ============================================================
   5. TEST CASE GENERATION ENGINE
   ============================================================ */

/**
 * handleGenerate()
 * Validates input, runs extraction + generation, renders results.
 */
function handleGenerate() {
  const text        = dom.requirementInput.value.trim();
  const featureType = dom.featureType.value;

  // ── Validate ──
  if (!text) {
    showInputError('Please enter a requirement or user story before generating.');
    return;
  }
  if (text.length < MIN_REQ_LENGTH) {
    showInputError(
      `Your requirement is too short (${text.length} chars). Please provide at least ${MIN_REQ_LENGTH} characters with more context about the feature.`
    );
    return;
  }

  clearInputError();

  // ── Disable button during "processing" (micro-UX) ──
  dom.generateBtn.disabled = true;
  dom.generateBtn.textContent = '⏳ Generating…';

  // Use a tiny timeout to let the UI repaint before heavy work
  setTimeout(() => {
    try {
      const constraints = extractConstraints(text);
      const fields      = detectFields(text);
      allTestCases      = generateTestCases(text, featureType, constraints, fields);

      renderResults(allTestCases);
      resetFilters();
      applyFilters();

      // Show results section
      dom.emptyState.hidden    = true;
      dom.resultsContent.hidden = false;

      // Scroll results into view on small screens
      dom.resultsContent.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (err) {
      console.error('TestForge generation error:', err);
      showToast('An unexpected error occurred. Please try again.', 'error');
    } finally {
      dom.generateBtn.disabled = false;
      dom.generateBtn.innerHTML = '<span class="btn-icon" aria-hidden="true">▶</span> Generate Test Cases';
    }
  }, 60);
}

/**
 * generateTestCases()
 * Orchestrates the full generation pipeline.
 * parsedFields is the structured array from parseFieldConstraints() and is
 * passed to feature-specific generators that need per-field detail.
 *
 * @param {string}   text
 * @param {string}   featureType
 * @param {Object}   constraints  - flat legacy object from extractConstraints()
 * @param {string[]} fieldNames   - display names array from detectFields()
 * @returns {Object[]} array of test case objects
 */
function generateTestCases(text, featureType, constraints, fieldNames) {
  // Re-parse to get the rich per-field descriptors for feature generators
  const { fields: parsedFields, global: parsedGlobal } = parseFieldConstraints(text);

  const cases = [];

  // 1. Generic cases driven by the flat constraints object
  cases.push(...getGenericCases(constraints, fieldNames, featureType));

  // 2. Feature-specific cases, receiving both flat constraints and parsed fields
  cases.push(...getFeatureSpecificCases(featureType, constraints, parsedFields, parsedGlobal));

  // 3. Remove duplicates by title
  const unique = deduplicateCases(cases);

  // 4. Guarantee all 4 categories, then assign IDs
  return assignIds(ensureAllCategories(unique, featureType, constraints, fieldNames));
}

/**
 * getGenericCases()
 * Produces test cases from the flat constraint object that apply regardless
 * of feature type.  Uses real field names from the parsed requirement.
 */
function getGenericCases(c, fields, featureType) {
  const cases = [];
  const primaryField = fields[0] || 'input field';
  const featureLower = featureType.toLowerCase();

  /* ── POSITIVE ── */
  cases.push({
    title:       `Valid ${primaryField} – happy path`,
    category:    'Positive',
    priority:    'High',
    preconditions: `User is on the ${featureLower} page. System is operational.`,
    steps:       [`Navigate to the ${featureLower} page`, `Enter a valid ${primaryField}`, 'Submit the form'],
    testData:    buildValidData(primaryField, c),
    expected:    'Operation completes successfully. User receives a success confirmation.'
  });

  if (c.mustAgree) {
    cases.push({
      title:       'Form submitted with all required checkboxes ticked',
      category:    'Positive',
      priority:    'Medium',
      preconditions: `User is on the ${featureLower} page. All required fields are filled with valid data.`,
      steps:       ['Fill all required fields with valid data', 'Tick the Terms & Conditions checkbox', 'Submit the form'],
      testData:    'All fields: valid values | Terms Checkbox: checked',
      expected:    'Form submits successfully.'
    });
  }

  /* ── NEGATIVE ── */
  if (c.isRequired) {
    cases.push({
      title:       `Required ${primaryField} left empty`,
      category:    'Negative',
      priority:    'High',
      preconditions: `User is on the ${featureLower} page.`,
      steps:       [`Leave the ${primaryField} field blank`, 'Attempt to submit the form'],
      testData:    `${primaryField}: (empty)`,
      expected:    'Form is not submitted. An inline validation error is shown: "This field is required."'
    });
  }

  if (c.hasEmail) {
    cases.push({
      title:       'Invalid email format',
      category:    'Negative',
      priority:    'High',
      preconditions: `User is on the ${featureLower} page.`,
      steps:       ['Enter a malformed value in the Email field', 'Submit the form'],
      testData:    'Email: not-an-email | Email: user@ | Email: @domain.com | Email: plaintext',
      expected:    'Validation error: "Please enter a valid email address."'
    });
  }

  if (c.mustMatch) {
    cases.push({
      title:       'Confirm Password does not match Password',
      category:    'Negative',
      priority:    'High',
      preconditions: `User is on the ${featureLower} page.`,
      steps:       ['Enter a valid value in the Password field', 'Enter a different value in Confirm Password', 'Submit the form'],
      testData:    'Password: Secure#Pass1 | Confirm Password: Different#Pass2',
      expected:    'Validation error: "Passwords do not match. Please re-enter."'
    });
  }

  if (c.mustAgree) {
    cases.push({
      title:       'Submit form with Terms & Conditions unchecked',
      category:    'Negative',
      priority:    'Medium',
      preconditions: `User is on the ${featureLower} page. All other required fields are filled.`,
      steps:       ['Fill all required fields with valid data', 'Leave the Terms Checkbox unchecked', 'Submit the form'],
      testData:    'Terms Checkbox: unchecked',
      expected:    'Form is not submitted. Error: "You must accept the Terms & Conditions."'
    });
  }

  if (c.maxAttempts) {
    cases.push({
      title:       `Account locked after ${c.maxAttempts} consecutive failed attempts`,
      category:    'Negative',
      priority:    'High',
      preconditions: 'An account with the test credentials exists in the system.',
      steps:       [
        'Enter the correct Email',
        `Enter an incorrect Password ${c.maxAttempts} times consecutively`,
        'Attempt to submit again'
      ],
      testData:    `Email: user@example.com | Password: wrong_password (repeated ${c.maxAttempts} times)`,
      expected:    c.lockDuration
        ? `Account is locked. Message: "Account locked for ${c.lockDuration} minutes due to too many failed attempts."`
        : 'Account is locked. Appropriate error message is displayed.'
    });
  }

  /* ── BOUNDARY ── */
  if (c.minLength) {
    cases.push({
      title:       `${primaryField} at exactly minimum length (${c.minLength} chars) – accepted`,
      category:    'Boundary',
      priority:    'Medium',
      preconditions: `User is on the ${featureLower} page.`,
      steps:       [`Enter a ${primaryField} with exactly ${c.minLength} characters`, 'Submit the form'],
      testData:    `${primaryField}: "${buildStringOfLength(c.minLength)}"  (${c.minLength} chars)`,
      expected:    'Input is accepted. No validation error.'
    });

    cases.push({
      title:       `${primaryField} one character below minimum (${c.minLength - 1} chars) – rejected`,
      category:    'Boundary',
      priority:    'Medium',
      preconditions: `User is on the ${featureLower} page.`,
      steps:       [`Enter a ${primaryField} with ${c.minLength - 1} characters`, 'Submit the form'],
      testData:    `${primaryField}: "${buildStringOfLength(c.minLength - 1)}"  (${c.minLength - 1} chars)`,
      expected:    `Validation error: "${primaryField} must be at least ${c.minLength} characters."`
    });
  }

  if (c.maxLength) {
    cases.push({
      title:       `${primaryField} at exactly maximum length (${c.maxLength} chars) – accepted`,
      category:    'Boundary',
      priority:    'Medium',
      preconditions: `User is on the ${featureLower} page.`,
      steps:       [`Enter a ${primaryField} with exactly ${c.maxLength} characters`, 'Submit the form'],
      testData:    `${primaryField}: "${buildStringOfLength(c.maxLength)}"  (${c.maxLength} chars)`,
      expected:    'Input is accepted. Form submits or field validates successfully.'
    });

    cases.push({
      title:       `${primaryField} one character above maximum (${c.maxLength + 1} chars) – rejected`,
      category:    'Boundary',
      priority:    'Medium',
      preconditions: `User is on the ${featureLower} page.`,
      steps:       [`Enter a ${primaryField} with ${c.maxLength + 1} characters`, 'Submit the form'],
      testData:    `${primaryField}: "${buildStringOfLength(c.maxLength + 1)}"  (${c.maxLength + 1} chars)`,
      expected:    `Validation error: "${primaryField} must not exceed ${c.maxLength} characters." OR input is truncated.`
    });
  }

  if (c.maxResults) {
    cases.push({
      title:       `Query returns exactly ${c.maxResults} results (boundary)`,
      category:    'Boundary',
      priority:    'Low',
      preconditions: `Exactly ${c.maxResults} matching records exist in the system.`,
      steps:       ['Enter a keyword that matches the maximum number of records', 'Submit the search'],
      testData:    `Search Query: keyword matching exactly ${c.maxResults} records`,
      expected:    `Exactly ${c.maxResults} results are displayed. No overflow or pagination error.`
    });
  }

  /* ── EDGE CASE ── */
  cases.push({
    title:       `${primaryField} contains only whitespace`,
    category:    'Edge Case',
    priority:    'Medium',
    preconditions: `User is on the ${featureLower} page.`,
    steps:       [`Enter only spaces or tabs in the ${primaryField} field`, 'Submit the form'],
    testData:    `${primaryField}: "   "  (whitespace only)`,
    expected:    c.trimmed
      ? `${primaryField} is trimmed to empty. Validation error: "This field is required."`
      : `Validation error: "${primaryField} must not be blank."`
  });

  cases.push({
    title:       'SQL injection attempt in input field',
    category:    'Edge Case',
    priority:    'High',
    preconditions: `User is on the ${featureLower} page.`,
    steps:       [`Enter a SQL injection payload into the ${primaryField} field`, 'Submit the form'],
    testData:    `${primaryField}: "' OR '1'='1'; DROP TABLE users;--"`,
    expected:    'Input is safely sanitised or rejected. No database manipulation occurs.'
  });

  if (c.specialChars || c.hasEmail || c.hasUsername) {
    cases.push({
      title:       'XSS script injection attempt in input field',
      category:    'Edge Case',
      priority:    'High',
      preconditions: `User is on the ${featureLower} page.`,
      steps:       [`Enter a script injection payload into the ${primaryField} field`, 'Submit the form'],
      testData:    `${primaryField}: "<script>alert('XSS')</script>"`,
      expected:    'Script is escaped or stripped. No JavaScript executes in the browser.'
    });
  }

  cases.push({
    title:       'Input contains Unicode and emoji characters',
    category:    'Edge Case',
    priority:    'Low',
    preconditions: `User is on the ${featureLower} page.`,
    steps:       [`Enter Unicode characters and emoji into the ${primaryField} field`, 'Submit the form'],
    testData:    `${primaryField}: "Ünïcödé 日本語 🎉"`,
    expected:    'System handles Unicode gracefully. No encoding errors or crashes.'
  });

  cases.push({
    title:       'Rapid double form submission',
    category:    'Edge Case',
    priority:    'Medium',
    preconditions: `User is on the ${featureLower} page. All fields contain valid data.`,
    steps:       ['Fill the form with valid data', 'Click the submit button twice in rapid succession'],
    testData:    'All fields: valid values | Action: double-click submit',
    expected:    'Form is submitted only once. No duplicate records are created. Submit button is disabled after first click.'
  });

  if (c.caseInsensitive) {
    cases.push({
      title:       'Case-insensitive input variations produce consistent results',
      category:    'Edge Case',
      priority:    'Low',
      preconditions: 'System is described as case-insensitive.',
      steps:       [`Enter "${primaryField}" in UPPERCASE`, `Enter the same value in lowercase`, `Enter in MiXeDcAsE`],
      testData:    `${primaryField}: "TestValue" | "testvalue" | "TESTVALUE" | "tEsTvAlUe"`,
      expected:    'All variations are treated equally. Results are consistent regardless of case.'
    });
  }

  return cases;
}


/* ============================================================
   6. FEATURE-SPECIFIC RULE SETS
   ============================================================ */

/**
 * getFeatureSpecificCases()
 * Routes to the appropriate feature generator.
 * parsedFields (FieldDescriptor[]) and parsedGlobal are only passed to
 * generators that use per-field detail (currently Registration).
 *
 * @param {string}           featureType
 * @param {Object}           c            - flat legacy constraints
 * @param {FieldDescriptor[]} parsedFields - from parseFieldConstraints()
 * @param {Object}           parsedGlobal  - global flags
 * @returns {Object[]}
 */
function getFeatureSpecificCases(featureType, c, parsedFields, parsedGlobal) {
  switch (featureType) {
    case 'Login':        return getLoginCases(c, parsedGlobal);
    case 'Registration': return getRegistrationCases(c, parsedFields, parsedGlobal);
    case 'Search':       return getSearchCases(c);
    case 'Payment':      return getPaymentCases(c);
    case 'Form Input':   return getFormInputCases(c, parsedFields);
    default:             return getOtherCases(c, parsedFields);
  }
}

/**
 * getLoginCases()
 * Login-specific test cases.  Preconditions and steps avoid "registered"
 * account language — the account simply "exists in the system".
 */
function getLoginCases(c, g) {
  const cases = [];

  cases.push({
    title:       'Valid credentials – successful login',
    category:    'Positive',
    priority:    'High',
    preconditions: 'A user account exists in the system with the test credentials. Login page is accessible.',
    steps:       ['Navigate to the login page', 'Enter the valid Email', 'Enter the correct Password', 'Click Login'],
    testData:    'Email: user@example.com | Password: Secure#Pass1',
    expected:    'Login succeeds. User is redirected to their dashboard.'
  });

  cases.push({
    title:       'Email not found in the system',
    category:    'Negative',
    priority:    'High',
    preconditions: 'No account exists for the test email address.',
    steps:       ['Enter an email address with no matching account', 'Enter any password', 'Click Login'],
    testData:    'Email: nonexistent@example.com | Password: AnyPass123!',
    expected:    'Error: "Invalid email or password." No account-existence detail is revealed for security.'
  });

  cases.push({
    title:       'Correct email, wrong password',
    category:    'Negative',
    priority:    'High',
    preconditions: 'An account exists in the system for the test email.',
    steps:       ['Enter the correct Email', 'Enter an incorrect Password', 'Click Login'],
    testData:    'Email: user@example.com | Password: WrongPass!',
    expected:    'Error: "Invalid email or password." User remains on the login page.'
  });

  if (g && g.hasRememberMe) {
    cases.push({
      title:       '"Remember Me" keeps session after browser close',
      category:    'Positive',
      priority:    'Medium',
      preconditions: 'An account exists in the system. Login page is accessible.',
      steps:       ['Enter the valid Email and Password', 'Tick the Remember Me checkbox', 'Click Login', 'Close and reopen the browser', 'Navigate to the protected page'],
      testData:    'Email: user@example.com | Password: Secure#Pass1 | Remember Me: checked',
      expected:    'Session persists. User is still logged in after reopening the browser.'
    });

    cases.push({
      title:       'Session expires on browser close without "Remember Me"',
      category:    'Positive',
      priority:    'Low',
      preconditions: 'An account exists in the system. Login page is accessible.',
      steps:       ['Enter the valid Email and Password', 'Leave Remember Me unchecked', 'Click Login', 'Close the browser', 'Reopen and navigate to the protected page'],
      testData:    'Email: user@example.com | Password: Secure#Pass1 | Remember Me: unchecked',
      expected:    'Session is not persisted. User is redirected to the login page.'
    });
  }

  cases.push({
    title:       'Password field is masked by default',
    category:    'Edge Case',
    priority:    'Medium',
    preconditions: 'User is on the login page.',
    steps:       ['Navigate to the login page', 'Observe the input type of the Password field', 'Type a password'],
    testData:    'N/A – HTML attribute check: input type="password"',
    expected:    'Password field type is "password". Characters are displayed as masked dots.'
  });

  return cases;
}

/**
 * getRegistrationCases()
 * Field-driven registration test cases.
 * Iterates parsedFields to produce:
 *   - One Positive case per field (with real field name in test data)
 *   - Boundary cases (min-1, min, max, max+1) for every field with a length constraint
 *   - Negative cases: empty field, invalid chars, duplicate value (where applicable)
 * Plus cross-field and edge cases at the end.
 *
 * Preconditions always state the user is NOT yet registered.
 */
function getRegistrationCases(c, parsedFields, g) {
  const cases = [];
  const REG_PRE = 'User does not have an existing account. Registration page is accessible.';

  // ── 1. One happy-path positive for the whole form ──
  {
    const tdParts = parsedFields
      .filter(f => !f.isConfirm && !f.isCheckbox)
      .map(f => {
        if (f.isEmail)    return `${f.name}: new_user@example.com`;
        if (f.isPassword) return `${f.name}: Secure#Pass1`;
        if (f.isDate)     return `${f.name}: ${getDateYearsAgo((c.minAge || 18) + 2)}`;
        if (f.minLength && f.maxLength)
          return `${f.name}: "${buildStringOfLength(Math.ceil((f.minLength + f.maxLength) / 2))}"`;
        return `${f.name}: valid_value`;
      });
    const confirmField = parsedFields.find(f => f.isConfirm);
    if (confirmField) tdParts.push(`${confirmField.name}: Secure#Pass1`);
    const checkboxField = parsedFields.find(f => f.isCheckbox);
    if (checkboxField) tdParts.push(`${checkboxField.name}: checked`);

    const steps = ['Navigate to the registration page'];
    parsedFields.filter(f => !f.isCheckbox).forEach(f => steps.push(`Enter a valid value in the ${f.name} field`));
    const cb = parsedFields.find(f => f.isCheckbox);
    if (cb) steps.push(`Tick the ${cb.name}`);
    steps.push('Click the Register / Submit button');

    cases.push({
      title:       'Successful registration with all valid inputs',
      category:    'Positive',
      priority:    'High',
      preconditions: REG_PRE,
      steps,
      testData:    tdParts.join(' | ') || 'All fields: valid values',
      expected:    'Account is created successfully. Confirmation message or email is shown.'
    });
  }

  // ── 2. Per-field cases ──
  for (const fd of parsedFields) {
    const fn = fd.name; // e.g. "Username", "Email", "Password"

    // Skip pure confirm/checkbox fields for individual field tests — covered separately
    if (fd.isCheckbox) continue;

    // ── Positive: valid value for this field ──
    cases.push({
      title:       `${fn} – valid value accepted`,
      category:    'Positive',
      priority:    'Medium',
      preconditions: `User is on the registration page. No account exists for the test ${fn}.`,
      steps:       [
        'Navigate to the registration page',
        `Enter a valid ${fn}`,
        'Fill all other required fields with valid data',
        'Submit the form'
      ],
      testData:    buildFieldTestData(fd, 'valid'),
      expected:    `${fn} is accepted. No validation error for this field.`
    });

    // ── Negative: field left empty ──
    cases.push({
      title:       `${fn} left empty – required field error`,
      category:    'Negative',
      priority:    'High',
      preconditions: 'User is on the registration page.',
      steps:       [
        'Navigate to the registration page',
        `Leave the ${fn} field blank`,
        'Fill all other fields with valid data',
        'Submit the form'
      ],
      testData:    `${fn}: (empty)`,
      expected:    `Form is not submitted. Inline error: "${fn} is required."`
    });

    // ── Negative: invalid characters (username only, or where alphanumeric rule exists) ──
    if (fd.alphanumeric || fd.noSpecialChars) {
      cases.push({
        title:       `${fn} with disallowed special characters`,
        category:    'Negative',
        priority:    'Medium',
        preconditions: 'User is on the registration page.',
        steps:       [
          'Navigate to the registration page',
          `Enter a ${fn} containing special characters (@, #, $, !)`,
          'Submit the form'
        ],
        testData:    `${fn}: "user@#$!"`,
        expected:    `Validation error: "${fn} may only contain letters, numbers, and underscores."`
      });
    }

    // ── Negative: invalid email format ──
    if (fd.isEmail) {
      cases.push({
        title:       `${fn} with invalid format`,
        category:    'Negative',
        priority:    'High',
        preconditions: 'User is on the registration page.',
        steps:       [
          'Navigate to the registration page',
          `Enter a malformed value in the ${fn} field`,
          'Submit the form'
        ],
        testData:    `${fn}: "notanemail" | "${fn}: user@" | "${fn}: @domain.com"`,
        expected:    `Validation error: "Please enter a valid ${fn.toLowerCase()}."`
      });
    }

    // ── Negative: duplicate value (where uniqueness required) ──
    if (fd.mustBeUnique) {
      cases.push({
        title:       `${fn} already exists in the system (duplicate)`,
        category:    'Negative',
        priority:    'High',
        preconditions: `An account already exists with the test ${fn}. User is on the registration page.`,
        steps:       [
          'Navigate to the registration page',
          `Enter a ${fn} that is already in use`,
          'Fill all other fields with valid data',
          'Submit the form'
        ],
        testData:    fd.isEmail
          ? `${fn}: existing@example.com  (already in system)`
          : `${fn}: taken_username  (already in system)`,
        expected:    `Error: "This ${fn.toLowerCase()} is already taken. Please choose another."`
      });
    }

    // ── Negative: password complexity failure ──
    if (fd.isPassword && fd.hasComplexity) {
      cases.push({
        title:       `${fn} missing required complexity (no uppercase, number, or special char)`,
        category:    'Negative',
        priority:    'High',
        preconditions: 'User is on the registration page.',
        steps:       [
          'Navigate to the registration page',
          `Enter a ${fn} that lacks required character types (e.g. all lowercase letters only)`,
          'Submit the form'
        ],
        testData:    `${fn}: "simplepassword"  (no uppercase, digit, or special character)`,
        expected:    `Validation error listing each unmet complexity rule (uppercase, digit, special character).`
      });
    }

    // ── Boundary cases for fields with length constraints ──
    if (fd.minLength !== null) {
      const minVal = fd.minLength;

      cases.push({
        title:       `${fn} at minimum length (${minVal} chars) – accepted`,
        category:    'Boundary',
        priority:    'High',
        preconditions: `User is on the registration page. No account exists for this test ${fn}.`,
        steps:       [`Navigate to the registration page`, `Enter a ${fn} of exactly ${minVal} characters`, 'Fill other fields and submit'],
        testData:    `${fn}: "${buildStringOfLength(minVal)}"  (${minVal} chars)`,
        expected:    `${fn} is accepted. No validation error.`
      });

      if (minVal > 1) {
        cases.push({
          title:       `${fn} one character below minimum (${minVal - 1} chars) – rejected`,
          category:    'Boundary',
          priority:    'High',
          preconditions: 'User is on the registration page.',
          steps:       [`Navigate to the registration page`, `Enter a ${fn} of only ${minVal - 1} characters`, 'Fill other fields and submit'],
          testData:    `${fn}: "${buildStringOfLength(minVal - 1)}"  (${minVal - 1} chars)`,
          expected:    `Validation error: "${fn} must be at least ${minVal} characters."`
        });
      }
    }

    if (fd.maxLength !== null) {
      const maxVal = fd.maxLength;

      cases.push({
        title:       `${fn} at maximum length (${maxVal} chars) – accepted`,
        category:    'Boundary',
        priority:    'Medium',
        preconditions: `User is on the registration page. No account exists for this test ${fn}.`,
        steps:       [`Navigate to the registration page`, `Enter a ${fn} of exactly ${maxVal} characters`, 'Fill other fields and submit'],
        testData:    `${fn}: "${buildStringOfLength(maxVal)}"  (${maxVal} chars)`,
        expected:    `${fn} is accepted. No validation error.`
      });

      cases.push({
        title:       `${fn} one character above maximum (${maxVal + 1} chars) – rejected`,
        category:    'Boundary',
        priority:    'Medium',
        preconditions: 'User is on the registration page.',
        steps:       [`Navigate to the registration page`, `Enter a ${fn} of ${maxVal + 1} characters`, 'Fill other fields and submit'],
        testData:    `${fn}: "${buildStringOfLength(maxVal + 1)}"  (${maxVal + 1} chars)`,
        expected:    `Validation error: "${fn} must not exceed ${maxVal} characters."`
      });
    }

    // ── Age boundary (Date of Birth) ──
    if (fd.isDate && fd.minAge !== null) {
      const age = fd.minAge;
      cases.push({
        title:       `${fn}: exactly ${age} years old today – accepted`,
        category:    'Boundary',
        priority:    'High',
        preconditions: 'User is on the registration page.',
        steps:       [`Navigate to the registration page`, `Enter a ${fn} that is exactly ${age} years ago from today`, 'Submit the form'],
        testData:    `${fn}: ${getDateYearsAgo(age)}  (exactly ${age} years old)`,
        expected:    `Age is accepted. Form proceeds without error.`
      });

      cases.push({
        title:       `${fn}: one day under ${age} years old – rejected`,
        category:    'Boundary',
        priority:    'High',
        preconditions: 'User is on the registration page.',
        steps:       [`Navigate to the registration page`, `Enter a ${fn} that is 1 day short of ${age} years ago`, 'Submit the form'],
        testData:    `${fn}: ${getDateYearsAgoPlusDays(age, 1)}  (${age} years minus 1 day)`,
        expected:    `Validation error: "You must be at least ${age} years old."`
      });
    }
  }

  // ── 3. Cross-field: confirm password mismatch ──
  const confirmFd = parsedFields.find(f => f.isConfirm);
  if (confirmFd) {
    cases.push({
      title:       `${confirmFd.name} does not match Password`,
      category:    'Negative',
      priority:    'High',
      preconditions: 'User is on the registration page.',
      steps:       ['Navigate to the registration page', 'Enter a valid Password', `Enter a different value in ${confirmFd.name}`, 'Submit the form'],
      testData:    `Password: Secure#Pass1 | ${confirmFd.name}: Different#Pass2`,
      expected:    `Validation error: "${confirmFd.name} does not match Password."`
    });

    cases.push({
      title:       `${confirmFd.name} matches Password – cross-field validation passes`,
      category:    'Positive',
      priority:    'Medium',
      preconditions: 'User is on the registration page.',
      steps:       ['Navigate to the registration page', 'Enter a valid Password', `Enter the identical value in ${confirmFd.name}`, 'Submit the form'],
      testData:    `Password: Secure#Pass1 | ${confirmFd.name}: Secure#Pass1`,
      expected:    `No mismatch error. Form proceeds to submit.`
    });
  }

  // ── 4. Terms checkbox ──
  const checkboxFd = parsedFields.find(f => f.isCheckbox);
  if (checkboxFd) {
    cases.push({
      title:       `${checkboxFd.name} unchecked – form blocked`,
      category:    'Negative',
      priority:    'Medium',
      preconditions: 'User is on the registration page. All other fields are filled with valid data.',
      steps:       ['Navigate to the registration page', 'Fill all required fields', `Leave the ${checkboxFd.name} unchecked`, 'Submit the form'],
      testData:    `${checkboxFd.name}: unchecked`,
      expected:    `Form is not submitted. Error: "You must accept the Terms & Conditions."`
    });
  }

  // ── 5. Edge cases ──
  cases.push({
    title:       'Paste into Confirm Password bypasses typing restriction',
    category:    'Edge Case',
    priority:    'Low',
    preconditions: 'User is on the registration page.',
    steps:       ['Enter a valid Password', 'Paste the same value into Confirm Password via clipboard'],
    testData:    'Password: Secure#Pass1 | Confirm Password: Secure#Pass1 (pasted)',
    expected:    'Pasted value is accepted. Fields match. No unexpected behaviour.'
  });

  cases.push({
    title:       'All fields submitted simultaneously blank',
    category:    'Edge Case',
    priority:    'Medium',
    preconditions: 'User is on the registration page.',
    steps:       ['Navigate to the registration page', 'Leave all fields blank', 'Click Register'],
    testData:    'All fields: (empty)',
    expected:    'Form is not submitted. Inline error shown on every required field simultaneously.'
  });

  return cases;
}

/**
 * getSearchCases()
 * Search-feature test cases driven by flat constraint flags.
 */
function getSearchCases(c) {
  const cases = [];

  cases.push({
    title:       'Valid keyword returns matching results',
    category:    'Positive',
    priority:    'High',
    preconditions: 'At least one matching record exists in the system.',
    steps:       ['Navigate to the search page', 'Enter a valid keyword in the Search Query field', 'Click Search or press Enter'],
    testData:    'Search Query: "laptop"',
    expected:    'Results page displays matching items. Result count is shown.'
  });

  cases.push({
    title:       'Keyword with no matching results shows empty state',
    category:    'Negative',
    priority:    'Medium',
    preconditions: 'No records matching the test keyword exist.',
    steps:       ['Navigate to the search page', 'Enter a keyword that yields no results', 'Click Search'],
    testData:    'Search Query: "xyzxyzxyz_no_match_9999"',
    expected:    'A friendly "No results found" message is displayed. No error is thrown.'
  });

  cases.push({
    title:       'Empty search query',
    category:    'Negative',
    priority:    'Medium',
    preconditions: 'User is on the search page.',
    steps:       ['Leave the Search Query field empty', 'Click Search or press Enter'],
    testData:    'Search Query: (empty)',
    expected:    'Either: (a) validation error "Please enter a search term", or (b) all records returned per design spec.'
  });

  cases.push({
    title:       'Search Query with leading/trailing whitespace',
    category:    'Boundary',
    priority:    'Low',
    preconditions: 'At least one matching record exists for the trimmed keyword.',
    steps:       ['Enter a keyword surrounded by spaces in the Search Query field', 'Click Search'],
    testData:    'Search Query: "  laptop  "  (leading and trailing spaces)',
    expected:    c.trimmed
      ? 'Whitespace is trimmed. Results match the trimmed query "laptop".'
      : 'System handles gracefully. Same results as query without surrounding whitespace.'
  });

  if (c.specialChars) {
    cases.push({
      title:       'Search Query containing HTML/script injection characters',
      category:    'Edge Case',
      priority:    'High',
      preconditions: 'User is on the search page.',
      steps:       ['Enter an XSS payload in the Search Query field', 'Click Search'],
      testData:    'Search Query: "<script>alert(1)</script>" | "\\" OR 1=1 --"',
      expected:    'Input is sanitised. No script executes. Safe error or empty result is shown.'
    });
  }

  cases.push({
    title:       'Search Query is case-insensitive',
    category:    'Edge Case',
    priority:    'Low',
    preconditions: 'Records for "Laptop" exist in the system.',
    steps:       ['Search for "laptop"', 'Search for "LAPTOP"', 'Search for "LaPtoP"'],
    testData:    'Search Query: "laptop" | "LAPTOP" | "LaPtoP"',
    expected:    c.caseInsensitive
      ? 'All three queries return identical results.'
      : 'Case handling matches the documented specification.'
  });

  if (c.maxResults) {
    cases.push({
      title:       `Search returns no more than ${c.maxResults} results per page`,
      category:    'Boundary',
      priority:    'Low',
      preconditions: `More than ${c.maxResults} matching records exist in the system.`,
      steps:       ['Enter a very broad keyword that matches many records', 'Click Search'],
      testData:    `Search Query: common word (matching > ${c.maxResults} records)`,
      expected:    `Exactly ${c.maxResults} results are shown. Pagination or "show more" is available if applicable.`
    });
  }

  return cases;
}

/**
 * getPaymentCases()
 * Payment-specific test cases.
 */
function getPaymentCases(c) {
  return [
    {
      title:       'Valid card details – payment succeeds',
      category:    'Positive',
      priority:    'High',
      preconditions: 'User has items in the cart. Payment page is accessible.',
      steps:       ['Enter a valid Card Number', 'Enter a valid expiry date', 'Enter a valid CVV', 'Click Pay'],
      testData:    'Card Number: 4111 1111 1111 1111 | Expiry: 12/26 | CVV: 123',
      expected:    'Payment is processed. Confirmation page shown. Confirmation email sent.'
    },
    {
      title:       'Invalid card number fails Luhn check',
      category:    'Negative',
      priority:    'High',
      preconditions: 'User is on the payment page.',
      steps:       ['Enter an invalid Card Number', 'Submit payment'],
      testData:    'Card Number: 4111 1111 1111 1112  (fails Luhn algorithm)',
      expected:    'Validation error: "Invalid card number. Please check and retry."'
    },
    {
      title:       'Expired card is rejected',
      category:    'Negative',
      priority:    'High',
      preconditions: 'User is on the payment page.',
      steps:       ['Enter a card with a past expiry date', 'Submit payment'],
      testData:    'Expiry: 01/20  (past date)',
      expected:    'Error: "Your card has expired. Please use a different card."'
    },
    {
      title:       'CVV at boundary: 2 digits (below min) and 4 digits (above standard)',
      category:    'Boundary',
      priority:    'Medium',
      preconditions: 'User is on the payment page.',
      steps:       ['Enter a CVV of 2 digits', 'Submit', 'Then enter a CVV of 4 digits', 'Submit again'],
      testData:    'CVV: "12"  (2 digits) | CVV: "1234"  (4 digits)',
      expected:    'Both fail validation. Error: "CVV must be 3 digits (4 for Amex)."'
    },
    {
      title:       'Payment amount of zero or negative value',
      category:    'Edge Case',
      priority:    'High',
      preconditions: 'User attempts to place an order with a zero or negative amount.',
      steps:       ['Manipulate cart or URL to set Amount to 0 or -1', 'Proceed to payment'],
      testData:    'Amount: 0.00 | Amount: -1.00',
      expected:    'Server rejects the transaction. Error: "Invalid order amount." No charge is made.'
    },
    {
      title:       'Network interruption mid-payment',
      category:    'Edge Case',
      priority:    'High',
      preconditions: 'User has filled valid payment details.',
      steps:       ['Begin the payment process', 'Simulate a network drop after submission'],
      testData:    'Network: disconnected after submit button click',
      expected:    'Payment is safely rolled back or idempotency prevents a double-charge. Appropriate error shown.'
    }
  ];
}

/**
 * getFormInputCases()
 * Generic form-input test cases using parsed field names where available.
 */
function getFormInputCases(c, parsedFields) {
  const cases = [];
  const field = (parsedFields && parsedFields[0] && parsedFields[0].name) || 'input field';

  cases.push({
    title:       `${field} – valid input accepted`,
    category:    'Positive',
    priority:    'High',
    preconditions: 'User is on the form page.',
    steps:       [`Enter a valid value in the ${field} field`, 'Move focus away (blur)', 'Submit the form'],
    testData:    `${field}: valid_sample_value`,
    expected:    'No validation error. Form submits successfully.'
  });

  cases.push({
    title:       'All required fields submitted blank simultaneously',
    category:    'Negative',
    priority:    'High',
    preconditions: 'User is on the form page.',
    steps:       ['Leave all required fields blank', 'Click the submit button'],
    testData:    'All required fields: (empty)',
    expected:    'Form is not submitted. Inline error shown on every required field.'
  });

  cases.push({
    title:       'Full keyboard tab-order navigates all fields',
    category:    'Edge Case',
    priority:    'Low',
    preconditions: 'User is on the form page using keyboard only.',
    steps:       ['Focus the first element', 'Press Tab repeatedly to cycle through all fields', 'Verify each receives focus'],
    testData:    'Input: Tab key only',
    expected:    'Every interactive element is reachable by keyboard in logical order. Focus indicator is visible on each.'
  });

  return cases;
}

/**
 * getOtherCases()
 * Baseline positive and negative cases for any unrecognised feature type.
 */
function getOtherCases(c, parsedFields) {
  const field = (parsedFields && parsedFields[0] && parsedFields[0].name) || 'input field';
  return [
    {
      title:       `${field} – valid input, baseline positive`,
      category:    'Positive',
      priority:    'High',
      preconditions: 'Feature is accessible and operational.',
      steps:       ['Navigate to the feature', `Enter a valid ${field}`, 'Submit or trigger the action'],
      testData:    `${field}: valid_value`,
      expected:    'Feature behaves as expected. Success state is shown.'
    },
    {
      title:       `${field} – invalid input, baseline negative`,
      category:    'Negative',
      priority:    'High',
      preconditions: 'Feature is accessible.',
      steps:       [`Enter an invalid or unexpected ${field}`, 'Submit or trigger the action'],
      testData:    `${field}: invalid_value`,
      expected:    'Appropriate error or rejection response is returned.'
    }
  ];
}

/**
 * buildFieldTestData()
 * Returns a test data string for a single FieldDescriptor.
 * Used to fill the per-field positive test cases in getRegistrationCases().
 *
 * @param {Object} fd   - FieldDescriptor
 * @param {'valid'|'min'|'max'} mode
 */
function buildFieldTestData(fd, mode) {
  if (fd.isEmail)    return `${fd.name}: new_user@example.com`;
  if (fd.isConfirm)  return `${fd.name}: Secure#Pass1  (matches Password)`;
  if (fd.isPassword) {
    const len = fd.minLength ? Math.max(fd.minLength, 8) : 8;
    return `${fd.name}: "${buildStringOfLength(len - 4)}Aa1!"  (${len} chars, meets complexity)`;
  }
  if (fd.isDate && fd.minAge !== null) {
    return `${fd.name}: ${getDateYearsAgo(fd.minAge + 2)}  (${fd.minAge + 2} years old, above minimum)`;
  }
  if (fd.minLength !== null && fd.maxLength !== null) {
    const midLen = Math.ceil((fd.minLength + fd.maxLength) / 2);
    return `${fd.name}: "${buildStringOfLength(midLen)}"  (${midLen} chars, within ${fd.minLength}–${fd.maxLength} range)`;
  }
  if (fd.minLength !== null) {
    return `${fd.name}: "${buildStringOfLength(fd.minLength + 2)}"  (${fd.minLength + 2} chars)`;
  }
  return `${fd.name}: valid_value`;
}


/* ============================================================
   GENERATION HELPERS
   ============================================================ */

/**
 * ensureAllCategories()
 * If any of the 4 required categories is missing, add a fallback case.
 */
function ensureAllCategories(cases, featureType, c, fields) {
  const existing = new Set(cases.map(tc => tc.category));
  const field = fields[0] || 'input field';

  if (!existing.has('Positive')) {
    cases.push({
      title:       'Standard successful operation',
      category:    'Positive',
      priority:    'High',
      preconditions: 'System is operational and user has valid credentials/data.',
      steps:       ['Provide all required valid inputs', 'Submit or trigger the feature'],
      testData:    'All inputs: valid sample values',
      expected:    'Operation completes successfully.'
    });
  }

  if (!existing.has('Negative')) {
    cases.push({
      title:       'Submission with invalid or missing data',
      category:    'Negative',
      priority:    'High',
      preconditions: 'User is on the feature page.',
      steps:       ['Provide invalid or missing data', 'Submit'],
      testData:    `${field}: invalid`,
      expected:    'Validation error is shown. Operation is rejected.'
    });
  }

  if (!existing.has('Boundary')) {
    cases.push({
      title:       'Input at the boundary of accepted range',
      category:    'Boundary',
      priority:    'Medium',
      preconditions: 'User is on the feature page.',
      steps:       ['Enter a value at the exact boundary of the accepted range', 'Submit'],
      testData:    `${field}: boundary value`,
      expected:    'Value is accepted (at boundary) or rejected (past boundary) per specification.'
    });
  }

  if (!existing.has('Edge Case')) {
    cases.push({
      title:       'Unexpected or extreme input',
      category:    'Edge Case',
      priority:    'Medium',
      preconditions: 'User is on the feature page.',
      steps:       ['Enter an extreme, unusual, or unexpected value', 'Submit'],
      testData:    `${field}: extreme/unexpected value`,
      expected:    'System handles the input gracefully. No crash or unhandled exception.'
    });
  }

  return cases;
}

/**
 * deduplicateCases()
 * Removes cases with identical (case-folded) titles.
 */
function deduplicateCases(cases) {
  const seen = new Set();
  return cases.filter(tc => {
    const key = tc.title.toLowerCase().replace(/\s+/g, ' ').trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * assignIds()
 * Assigns TC-001, TC-002, … sorted by category order then priority.
 */
function assignIds(cases) {
  const categoryIndex = Object.fromEntries(CATEGORIES.map((c, i) => [c, i]));

  cases.sort((a, b) => {
    const catDiff = (categoryIndex[a.category] ?? 99) - (categoryIndex[b.category] ?? 99);
    if (catDiff !== 0) return catDiff;
    return (PRIORITY_WEIGHT[b.priority] ?? 0) - (PRIORITY_WEIGHT[a.priority] ?? 0);
  });

  return cases.map((tc, i) => ({
    ...tc,
    id: `TC-${String(i + 1).padStart(3, '0')}`
  }));
}


/* ============================================================
   7. RENDERER
   ============================================================ */

/**
 * renderResults()
 * Renders the summary bar and populates the table body.
 * Called after generation and after every filter change.
 *
 * @param {Object[]} cases - array of test case objects to display
 * @param {Object[]} [all]  - full unfiltered set (for summary counts); defaults to allTestCases
 */
function renderResults(cases, all) {
  const source = all || allTestCases;

  renderSummaryBar(source);
  renderTable(cases);
}

/**
 * renderSummaryBar()
 * Shows category counts as coloured pill badges.
 */
function renderSummaryBar(cases) {
  const counts = {};
  for (const cat of CATEGORIES) counts[cat] = 0;
  cases.forEach(tc => { if (counts[tc.category] !== undefined) counts[tc.category]++; });

  const total = cases.length;
  const classMap = {
    'Positive':  'positive',
    'Negative':  'negative',
    'Boundary':  'boundary',
    'Edge Case': 'edge'
  };

  let html = `<span class="summary-badge total">Total: ${total}</span>`;
  for (const cat of CATEGORIES) {
    html += `<span class="summary-badge ${classMap[cat]}">${cat}: ${counts[cat]}</span>`;
  }
  dom.summaryBar.innerHTML = html;
}

/**
 * renderTable()
 * Builds table rows from the given test cases.
 */
function renderTable(cases) {
  if (cases.length === 0) {
    dom.testCasesBody.innerHTML = '';
    dom.noFilterMatch.hidden = false;
    return;
  }

  dom.noFilterMatch.hidden = true;

  const catClass = {
    'Positive':  'positive',
    'Negative':  'negative',
    'Boundary':  'boundary',
    'Edge Case': 'edge'
  };

  const prioClass = {
    'High':   'high',
    'Medium': 'medium',
    'Low':    'low'
  };

  dom.testCasesBody.innerHTML = cases.map(tc => {
    const stepsHtml = Array.isArray(tc.steps)
      ? `<ol class="steps-list">${tc.steps.map(s => `<li>${escapeHtml(s)}</li>`).join('')}</ol>`
      : escapeHtml(tc.steps);

    return `
      <tr>
        <td><span class="tc-id">${escapeHtml(tc.id)}</span></td>
        <td>${escapeHtml(tc.title)}</td>
        <td><span class="pill pill-${catClass[tc.category] || ''}">${escapeHtml(tc.category)}</span></td>
        <td><span class="pill prio-${prioClass[tc.priority] || ''}">${escapeHtml(tc.priority)}</span></td>
        <td>${escapeHtml(tc.preconditions)}</td>
        <td>${stepsHtml}</td>
        <td>${escapeHtml(tc.testData)}</td>
        <td>${escapeHtml(tc.expected)}</td>
      </tr>`;
  }).join('');
}


/* ============================================================
   8. FILTER LOGIC
   ============================================================ */

function applyFilters() {
  const cat  = dom.filterCategory.value;
  const prio = dom.filterPriority.value;

  const filtered = allTestCases.filter(tc => {
    const catMatch  = cat  === 'all' || tc.category === cat;
    const prioMatch = prio === 'all' || tc.priority === prio;
    return catMatch && prioMatch;
  });

  renderTable(filtered);
}

function clearFilters() {
  dom.filterCategory.value = 'all';
  dom.filterPriority.value = 'all';
  applyFilters();
}

function resetFilters() {
  dom.filterCategory.value = 'all';
  dom.filterPriority.value = 'all';
}


/* ============================================================
   9. EXPORT: CSV
   ============================================================ */

/**
 * exportCsv()
 * Serialises all test cases to CSV and triggers a file download.
 */
function exportCsv() {
  if (allTestCases.length === 0) {
    showToast('No test cases to export.', 'error');
    return;
  }

  const headers = ['ID', 'Title', 'Category', 'Priority', 'Preconditions', 'Steps', 'Test Data', 'Expected Result'];

  const rows = allTestCases.map(tc => [
    tc.id,
    tc.title,
    tc.category,
    tc.priority,
    tc.preconditions,
    Array.isArray(tc.steps) ? tc.steps.join(' → ') : tc.steps,
    tc.testData,
    tc.expected
  ].map(csvCell));

  const csv = [headers.map(csvCell).join(','), ...rows.map(r => r.join(','))].join('\r\n');

  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `testforge-test-cases-${dateStamp()}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  showToast('CSV downloaded successfully.', 'success');
}

/** Wraps a value in CSV-safe double quotes. */
function csvCell(value) {
  const str = String(value ?? '').replace(/"/g, '""');
  return `"${str}"`;
}


/* ============================================================
   10. EXPORT: MARKDOWN (COPY TO CLIPBOARD)
   ============================================================ */

/**
 * exportMarkdown()
 * Builds a Markdown document from all test cases and copies it to clipboard.
 */
function exportMarkdown() {
  if (allTestCases.length === 0) {
    showToast('No test cases to export.', 'error');
    return;
  }

  const featureType = dom.featureType.value;
  const lines = [];

  lines.push(`# Test Cases – ${featureType}`);
  lines.push(`> Generated by TestForge on ${new Date().toLocaleDateString()}`);
  lines.push('');
  lines.push(`**Total:** ${allTestCases.length} test cases`);
  lines.push('');

  // Summary table
  lines.push('## Summary');
  lines.push('');
  lines.push('| Category | Count |');
  lines.push('|----------|-------|');
  for (const cat of CATEGORIES) {
    const count = allTestCases.filter(tc => tc.category === cat).length;
    lines.push(`| ${cat} | ${count} |`);
  }
  lines.push('');

  // Individual cases grouped by category
  for (const cat of CATEGORIES) {
    const catCases = allTestCases.filter(tc => tc.category === cat);
    if (catCases.length === 0) continue;

    lines.push(`## ${cat} Tests`);
    lines.push('');

    for (const tc of catCases) {
      lines.push(`### ${tc.id}: ${tc.title}`);
      lines.push('');
      lines.push(`| Field | Detail |`);
      lines.push(`|-------|--------|`);
      lines.push(`| **Category** | ${tc.category} |`);
      lines.push(`| **Priority** | ${tc.priority} |`);
      lines.push(`| **Preconditions** | ${tc.preconditions} |`);
      lines.push(`| **Test Data** | ${tc.testData} |`);
      lines.push(`| **Expected Result** | ${tc.expected} |`);
      lines.push('');
      lines.push('**Steps:**');
      lines.push('');
      if (Array.isArray(tc.steps)) {
        tc.steps.forEach((step, i) => lines.push(`${i + 1}. ${step}`));
      } else {
        lines.push(`1. ${tc.steps}`);
      }
      lines.push('');
      lines.push('---');
      lines.push('');
    }
  }

  const markdown = lines.join('\n');

  // Use Clipboard API (available in modern browsers even without HTTPS for local files in most browsers)
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(markdown)
      .then(() => showToast('Markdown copied to clipboard!', 'success'))
      .catch(() => fallbackCopyToClipboard(markdown));
  } else {
    fallbackCopyToClipboard(markdown);
  }
}

/**
 * fallbackCopyToClipboard()
 * Uses a temporary textarea for environments where Clipboard API is unavailable.
 */
function fallbackCopyToClipboard(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0;';
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  try {
    const ok = document.execCommand('copy');
    showToast(ok ? 'Markdown copied to clipboard!' : 'Could not copy. Try manually.', ok ? 'success' : 'error');
  } catch (_) {
    showToast('Clipboard not available. Please copy manually.', 'error');
  }
  document.body.removeChild(ta);
}


/* ============================================================
   11. TOAST NOTIFICATIONS
   ============================================================ */

let toastTimer = null;

/**
 * showToast()
 * Displays a brief notification at the bottom-right of the screen.
 *
 * @param {string} message
 * @param {'success'|'error'|''} [type='']
 */
function showToast(message, type = '') {
  const t = dom.toast;

  // Clear any running timer
  if (toastTimer) clearTimeout(toastTimer);

  t.textContent = message;
  t.className   = `toast${type ? ' ' + type : ''}`;
  t.hidden      = false;

  // Allow the paint before adding .show (CSS transition)
  requestAnimationFrame(() => requestAnimationFrame(() => t.classList.add('show')));

  toastTimer = setTimeout(() => {
    t.classList.remove('show');
    // Wait for transition out before hiding completely
    setTimeout(() => { t.hidden = true; }, 250);
  }, 3200);
}


/* ============================================================
   12. UTILITY HELPERS
   ============================================================ */

/** Escape HTML special characters to prevent XSS in rendered output */
function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Show inline validation error on the textarea */
function showInputError(message) {
  dom.reqError.textContent = message;
  dom.reqError.hidden      = false;
  dom.requirementInput.classList.add('error');
  dom.requirementInput.setAttribute('aria-invalid', 'true');
  dom.requirementInput.focus();
}

/** Clear inline validation error */
function clearInputError() {
  dom.reqError.hidden = true;
  dom.reqError.textContent = '';
  dom.requirementInput.classList.remove('error');
  dom.requirementInput.removeAttribute('aria-invalid');
}

/**
 * Build a sample valid test data string for a given field.
 * @param {string} field
 * @param {Object} c  - constraints
 */
function buildValidData(field, c) {
  const f = field.toLowerCase();
  if (f.includes('email'))    return 'email: user@example.com';
  if (f.includes('password')) return `password: ${buildStringOfLength(Math.max(c.minLength || 8, 8))}Aa1!`;
  if (f.includes('username')) return 'username: valid_user_1';
  if (f.includes('phone'))    return 'phone: +1-555-000-1234';
  if (f.includes('url'))      return 'url: https://example.com';
  if (f.includes('search') || f.includes('query')) return 'query: "sample search term"';
  if (c.minLength)             return `value: "${buildStringOfLength(c.minLength)}"`;
  return 'value: valid_sample_value';
}

/** Build a repeating-character string of the given length */
function buildStringOfLength(n) {
  if (n <= 0) return '';
  const chars = 'abcdefghijklmnopqrstuvwxyz';
  let result = '';
  for (let i = 0; i < n; i++) result += chars[i % chars.length];
  return result;
}

/** Build a string 1 char shorter than n */
function buildShortString(n) {
  return buildStringOfLength(Math.max(n, 0));
}

/** Returns a date string (YYYY-MM-DD) for N years ago from today */
function getDateYearsAgo(years) {
  const d = new Date();
  d.setFullYear(d.getFullYear() - years);
  return d.toISOString().slice(0, 10);
}

/** Returns a date string for (N years - plusDays days) ago */
function getDateYearsAgoPlusDays(years, plusDays) {
  const d = new Date();
  d.setFullYear(d.getFullYear() - years);
  d.setDate(d.getDate() + plusDays);
  return d.toISOString().slice(0, 10);
}

/** Returns a compact YYYYMMDD stamp for filenames */
function dateStamp() {
  return new Date().toISOString().slice(0, 10).replace(/-/g, '');
}

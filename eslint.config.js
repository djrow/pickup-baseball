const js = require('@eslint/js');
const globals = require('globals');

const CLIENT_ES6_RESTRICTIONS = [
  'error',
  {
    selector: 'ChainExpression',
    message: 'Optional chaining (?.) is disallowed in public/js and sw.js (AGENTS.md invariant #2).'
  },
  {
    selector: 'LogicalExpression[operator="??"]',
    message: 'Nullish coalescing (??) is disallowed in public/js and sw.js (AGENTS.md invariant #2).'
  }
];

const SHARED_SECURITY_RULES = {
  'no-empty': 'error',
  'no-eval': 'error',
  'no-implied-eval': 'error',
  'no-new-func': 'error',
  'no-undef': 'error',
  'no-unused-vars': [
    'error',
    {
      vars: 'all',
      args: 'after-used',
      argsIgnorePattern: '^_',
      varsIgnorePattern: '^_',
      destructuredArrayIgnorePattern: '^_',
      ignoreRestSiblings: true,
      caughtErrors: 'none'
    }
  ]
};

module.exports = [
  {
    ignores: [
      'node_modules/**',
      '.wrangler/**',
      '_worker.bundle/**',
      'data/**',
      '.eslintcache'
    ]
  },

  // Base recommended rules
  js.configs.recommended,

  // Backend ESM (Cloudflare Workers / Pages Functions + Hono app + workers/ directory)
  {
    files: ['src/app/**/*.js', 'functions/**/*.js', 'workers/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.worker,
        ...globals.nodeBuiltin
      }
    },
    rules: {
      ...SHARED_SECURITY_RULES
    }
  },

  // Node.js CJS (host server, CLI scripts, tests, root config)
  {
    files: ['eslint.config.js', 'src/*.js', 'scripts/**/*.js', 'tests/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        ...globals.node
      }
    },
    rules: {
      ...SHARED_SECURITY_RULES
    }
  },

  // Service Worker
  {
    files: ['public/sw.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: {
        ...globals.serviceworker
      }
    },
    rules: {
      ...SHARED_SECURITY_RULES,
      'no-restricted-syntax': CLIENT_ES6_RESTRICTIONS
    }
  },

  // Client browser scripts (all files under public/js)
  {
    files: ['public/js/*.js', 'public/js/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: {
        ...globals.browser,
        PBFDialog: 'readonly',
        WeatherService: 'readonly',
        ClubhouseStore: 'readonly',
        ClubhouseCrypto: 'readonly',
        ClubhouseRTC: 'readonly',
        ArtStudio: 'readonly',
        module: 'readonly',
        require: 'readonly'
      }
    },
    rules: {
      ...SHARED_SECURITY_RULES,
      'no-restricted-syntax': CLIENT_ES6_RESTRICTIONS
    }
  },
  // `api.js` declares top-level `const API = ...`; expose `API` only to other client scripts
  {
    files: ['public/js/*.js', 'public/js/**/*.js'],
    ignores: ['public/js/api.js'],
    languageOptions: {
      globals: {
        API: 'readonly'
      }
    }
  },

  // Existing IIFE client modules: enforce zero accidental top-level globals
  {
    files: [
      'public/js/api.js',
      'public/js/api/*.js',
      'public/js/art.js',
      'public/js/clubhouse.js',
      'public/js/clubhouse/*.js',
      'public/js/crypto.js',
      'public/js/dialog.js',
      'public/js/gallery.js',
      'public/js/rtc.js',
      'public/js/store.js',
      'public/js/store/*.js',
      'public/js/waiver.js',
      'public/js/weather.js'
    ],
    rules: {
      'no-implicit-globals': ['error', { lexicalBindings: true }]
    }
  }
];

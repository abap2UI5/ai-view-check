#!/usr/bin/env node
/*
 * generate-schema — data/abap2ui5lint.schema.json from the rule registry.
 *
 * abaplint's config gets editor completion because a JSON schema describes
 * it; ours is generated so the rule list in the schema can never drift from
 * the rule list in lib/findings.mjs. A repo points at it with
 *
 *   { "$schema": "https://raw.githubusercontent.com/abap2UI5/abap2UI5-linter/main/data/abap2ui5lint.schema.json" }
 *
 *   node scripts/generate-schema.mjs           write the file
 *   node scripts/generate-schema.mjs --check   exit 1 if the committed file
 *                                              is stale (the test uses this)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { RULES, SEVERITIES, defaultSeverityOf } from '../lib/findings.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SCHEMA_FILE = path.join(ROOT, 'data', 'abap2ui5lint.schema.json');

const severity = { enum: [...SEVERITIES] };

export function buildSchema() {
  const rules = {};
  for (const id of RULES) {
    rules[id] = {
      $ref: '#/definitions/rule',
      description: `abap2UI5-linter rule '${id}' — default severity: ${defaultSeverityOf(id)}`,
    };
  }
  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: 'https://raw.githubusercontent.com/abap2UI5/abap2UI5-linter/main/data/abap2ui5lint.schema.json',
    title: 'abap2ui5lint.jsonc',
    description: 'Configuration for abap2UI5-linter (https://github.com/abap2UI5/abap2UI5-linter)',
    type: 'object',
    additionalProperties: false,
    properties: {
      $schema: { type: 'string', description: 'URL of this schema — editor completion only' },
      paths: {
        type: 'array',
        items: { type: 'string' },
        description: 'Files or directories to check. Used only when the CLI got no positional paths.',
      },
      ui5: {
        type: 'string',
        pattern: '^\\d+\\.\\d+(\\.\\d+)?$',
        description: 'The UI5 version the target system runs. Controls and members introduced later are reported; deprecations are reported once in effect at this version.',
      },
      minUi5: { type: 'string', pattern: '^\\d+\\.\\d+(\\.\\d+)?$', description: 'Alias of "ui5".' },
      distribution: {
        enum: ['sapui5', 'openui5'],
        description: 'Which distribution the target system serves. On "openui5", controls from SAPUI5-only libraries are reported.',
      },
      allow: {
        type: 'array',
        items: { type: 'string' },
        description: 'Control or control.member names accepted despite the version floor, e.g. "sap.m.Avatar.displaySize".',
      },
      render: { type: 'boolean', description: 'false skips the render gate (no browser needed).' },
      properties: { type: 'boolean', description: 'false skips the property gate.' },
      failOn: {
        enum: [...SEVERITIES, 'never'],
        description: 'Lowest severity that fails the build. Everything is always reported — this only decides the exit code.',
      },
      rules: {
        type: 'object',
        additionalProperties: false,
        description: 'Per rule: false to switch it off, a severity string, or { severity, exclude }.',
        properties: rules,
      },
    },
    definitions: {
      rule: {
        anyOf: [
          { type: 'boolean', description: 'false switches the rule off' },
          { ...severity, description: 'severity override' },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              severity: { ...severity, description: 'severity override' },
              exclude: {
                type: 'array',
                items: { type: 'string', format: 'regex' },
                description: 'File regex patterns this rule is not applied to, case insensitive.',
              },
            },
          },
        ],
      },
    },
  };
}

export const render = () => `${JSON.stringify(buildSchema(), null, 2)}\n`;

const invokedDirectly = process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const text = render();
  if (process.argv.includes('--check')) {
    const current = fs.existsSync(SCHEMA_FILE) ? fs.readFileSync(SCHEMA_FILE, 'utf8') : '';
    if (current !== text) {
      console.error('data/abap2ui5lint.schema.json is stale — run: npm run generate-schema');
      process.exit(1);
    }
    console.log('data/abap2ui5lint.schema.json is up to date');
  } else {
    fs.writeFileSync(SCHEMA_FILE, text);
    console.log(`wrote ${path.relative(ROOT, SCHEMA_FILE)} (${RULES.length} rules)`);
  }
}

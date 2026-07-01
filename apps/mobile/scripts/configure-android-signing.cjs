#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const root = process.cwd();
const androidDir = path.join(root, 'android');
const appGradle = path.join(androidDir, 'app', 'build.gradle');
const gradleProps = path.join(androidDir, 'gradle.properties');

function fail(message) {
  console.error(`Android signing config error: ${message}`);
  process.exit(1);
}

const required = [
  'ANDROID_KEYSTORE_BASE64',
  'ANDROID_KEYSTORE_PASSWORD',
  'ANDROID_KEY_ALIAS',
  'ANDROID_KEY_PASSWORD'
];
const missing = required.filter((key) => !process.env[key]);
if (missing.length) {
  fail(`missing GitHub Actions secrets: ${missing.join(', ')}. See README Android release section.`);
}
if (!fs.existsSync(appGradle)) fail(`missing ${appGradle}; run expo prebuild first`);

const keystorePath = path.join(androidDir, 'app', 'tricli-release.keystore');
fs.writeFileSync(keystorePath, Buffer.from(process.env.ANDROID_KEYSTORE_BASE64, 'base64'));
fs.appendFileSync(gradleProps, `\nTRICLI_UPLOAD_STORE_FILE=tricli-release.keystore\nTRICLI_UPLOAD_STORE_PASSWORD=${process.env.ANDROID_KEYSTORE_PASSWORD}\nTRICLI_UPLOAD_KEY_ALIAS=${process.env.ANDROID_KEY_ALIAS}\nTRICLI_UPLOAD_KEY_PASSWORD=${process.env.ANDROID_KEY_PASSWORD}\n`);

let text = fs.readFileSync(appGradle, 'utf8');
if (!text.includes('TRICLI_UPLOAD_STORE_FILE')) {
  text = text.replace(/signingConfigs\s*\{/, `signingConfigs {\n        tricliRelease {\n            storeFile file(TRICLI_UPLOAD_STORE_FILE)\n            storePassword TRICLI_UPLOAD_STORE_PASSWORD\n            keyAlias TRICLI_UPLOAD_KEY_ALIAS\n            keyPassword TRICLI_UPLOAD_KEY_PASSWORD\n        }`);
  text = text.replace(/release\s*\{([\s\S]*?)signingConfig\s+signingConfigs\.debug/, 'release {$1signingConfig signingConfigs.tricliRelease');
  if (!text.includes('signingConfig signingConfigs.tricliRelease')) {
    text = text.replace(/release\s*\{/, 'release {\n            signingConfig signingConfigs.tricliRelease');
  }
  fs.writeFileSync(appGradle, text);
}
console.log('Android release signing configured.');

// LOCAL DEVELOPMENT ONLY. On Railway, set the SMTP variables in Railway > Variables instead; this file is not used there.
// One-time helper: asks for your Gmail address + App Password, saves them to .env, and sends a test email.
// Run with:  npm run setup-email
const fs = require('fs');
const path = require('path');
const readline = require('readline');

let nodemailer;
try {
  nodemailer = require('nodemailer');
} catch (_) {
  console.log('The "nodemailer" package is missing. Run "npm install" first, then run this again.');
  process.exit(1);
}

const envFile = path.join(__dirname, '.env');
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((resolve) => rl.question(q, (a) => resolve(a.trim())));

(async () => {
  console.log('\nScopeDesk email setup (Gmail)\n');
  console.log('You need a Gmail "App Password":');
  console.log('  1. Open your Google Account > Security and turn on 2-Step Verification.');
  console.log('  2. Search "App passwords" in your Google Account, create one named ScopeDesk.');
  console.log('  3. Copy the 16 letters Google shows you.\n');

  const user = await ask('Your Gmail address: ');
  const pass = (await ask('App Password (16 letters, spaces are fine): ')).replace(/\s+/g, '');
  rl.close();

  if (!/^[^\s@]+@gmail\.com$/i.test(user) || pass.length < 16) {
    console.log('\nThat does not look right. Use a full @gmail.com address and the 16-letter App Password (not your normal password).');
    process.exit(1);
  }

  console.log('\nTesting the login...');
  const transport = nodemailer.createTransport({ host: 'smtp.gmail.com', port: 465, secure: true, auth: { user, pass } });
  try {
    await transport.verify();
    await transport.sendMail({
      from: `ScopeDesk <${user}>`,
      to: user,
      subject: 'ScopeDesk email is working',
      text: 'Success! ScopeDesk can now send password-reset emails.'
    });
  } catch (err) {
    console.log('\nGmail rejected the login: ' + err.message);
    console.log('Check that 2-Step Verification is on and that you used an App Password. Nothing was saved.');
    process.exit(1);
  }

  const settings = {
    SMTP_HOST: 'smtp.gmail.com',
    SMTP_PORT: '465',
    SMTP_USER: user,
    SMTP_PASS: pass,
    MAIL_FROM: `ScopeDesk <${user}>`
  };
  let lines = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8').split(/\r?\n/) : [];
  lines = lines.filter((l) => !Object.keys(settings).some((k) => l.startsWith(k + '=')) && l.trim() !== '');
  Object.entries(settings).forEach(([k, v]) => lines.push(`${k}=${v}`));
  fs.writeFileSync(envFile, lines.join('\n') + '\n', { mode: 0o600 });

  console.log('\nDone! A test email was sent to ' + user + ' and your settings were saved in .env');
  console.log('Restart ScopeDesk. You should see: [MAIL] Email is ready.');
})();

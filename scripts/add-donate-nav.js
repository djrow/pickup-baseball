const fs = require('fs');
const files = ['index', 'login', 'admin', 'event', 'profile'].map(n => `public/${n}.html`).concat(['public/js/api.js']);
const re = /^([ \t]*)<a href="\/index\.html">Games<\/a>/m;
for (const f of files) {
  let t = fs.readFileSync(f, 'utf8');
  if (t.includes('href="/donate.html"')) { console.log('already', f); continue; }
  if (!re.test(t)) { console.log('NO MATCH', f); continue; }
  t = t.replace(re, (m, ws) => `${m}\n${ws}<a href="/donate.html">Donate</a>`);
  fs.writeFileSync(f, t);
  console.log('updated', f);
}

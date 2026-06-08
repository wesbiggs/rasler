import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { marked } from 'marked';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = resolve(ROOT, 'public');

mkdirSync(OUT, { recursive: true });

// README.md → index.html; everything else keeps its basename.
function outName(mdFile) {
  return mdFile === 'README.md' ? 'index.html' : mdFile.replace(/\.md$/, '.html');
}

// Rewrite .md hrefs to their output filenames, preserving any #anchor.
function rewriteLinks(html) {
  return html.replace(/href="([^"#]+\.md)(#[^"]*)?"/g, (_, file, anchor = '') =>
    `href="${outName(basename(file))}${anchor}"`
  );
}

function titleFrom(md) {
  const m = md.match(/^#+ (.+)/m);
  return m ? m[1].trim() : 'RASLer';
}

function wrap(title, body) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  body { max-width: 860px; margin: 2rem auto; padding: 0 1.25rem;
         font: 1rem/1.6 system-ui, sans-serif; color: #1a1a1a; }
  a { color: #0969da; }
  h1, h2, h3 { line-height: 1.25; }
  h1 { border-bottom: 1px solid #d0d7de; padding-bottom: .3em; }
  h2 { border-bottom: 1px solid #d0d7de; padding-bottom: .3em; }
  pre { background: #f6f8fa; border-radius: 6px; padding: 1em; overflow-x: auto; }
  code { font-size: .9em; }
  pre code { font-size: inherit; }
  :not(pre) > code { background: #f6f8fa; padding: .15em .3em; border-radius: 4px; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid #d0d7de; padding: .4em .75em; text-align: left; }
  th { background: #f6f8fa; }
  blockquote { border-left: 4px solid #d0d7de; margin: 0; padding: 0 1em; color: #57606a; }
</style>
</head>
<body>
${body}
</body>
</html>
`;
}

const mdFiles = readdirSync(ROOT).filter(f => f.endsWith('.md')).sort();

for (const file of mdFiles) {
  const md = readFileSync(resolve(ROOT, file), 'utf8');
  const body = rewriteLinks(marked.parse(md));
  const html = wrap(titleFrom(md), body);
  const out = resolve(OUT, outName(file));
  writeFileSync(out, html);
  console.log(`${file} → public/${outName(file)}`);
}

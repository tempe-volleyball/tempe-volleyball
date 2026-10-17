# Lighthouse baseline: live tempevb.com (WordPress)

Run 2026-10-17 with Lighthouse 12, headless Chrome, from Sydney. Default mobile throttling unless marked desktop.
Full reports are the gzipped JSON files in this folder (open with https://googlechrome.github.io/lighthouse/viewer/).

| Page       | Form    | Perf | A11y | Best pr. | SEO | LCP   | CLS   | Page weight |
| ---------- | ------- | ---- | ---- | -------- | --- | ----- | ----- | ----------- |
| /          | mobile  | 51   | 87   | 100      | 85  | 5.8 s | 0.419 | 1,121 KiB   |
| /          | desktop | 76   | 92   | 100      | 85  | 2.5 s | 0.001 | 1,125 KiB   |
| /ladders/  | mobile  | 48   | 86   | 100      | 92  | 7.2 s | 0.419 | 1,128 KiB   |
| /ladders/  | desktop | 66   | 91   | 100      | 92  | 3.3 s | 0.004 | 1,124 KiB   |
| /fixtures/ | mobile  | 48   | 86   | 100      | 85  | 6.1 s | 0.419 | 1,129 KiB   |
| /fixtures/ | desktop | 72   | 91   | 100      | 85  | 2.7 s | 0.007 | 1,124 KiB   |

Failing audits (mobile, all three pages):

- Accessibility: `button-name` (mobile menu toggle has no label), `color-contrast` (light-blue text on the blue tables,
  white on amber), `frame-title`, `heading-order`.
- SEO: `meta-description` missing everywhere; `link-text` ("here" x5) on the homepage.
- Performance: FCP ~3.1 s, LCP 5.8–7.2 s, CLS 0.419 (layout shift from the header image and web fonts).

Targets for the rebuild: mobile Perf ≥ 90, A11y ≥ 95, SEO 100, CLS < 0.1, LCP < 2.5 s, page weight well under 300 KiB.

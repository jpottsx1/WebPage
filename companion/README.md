# Reader's Companions

A spoiler-free "who's who" for a book: the reader picks the chapter they've
reached and sees only the people, places and things met by then.

The data comes from Sgeulai: **Export ▸ Handoff to Narrator, Translator or
Readers ▸ Reader's Companion for Your Website (Folder)…**. Only the text in
each record's "For readers" field is published — never its summary.

## Adding a book

1. Copy `_template/` to a new folder named for the book, e.g. `companion/my-book/`.
2. In its `index.html`, replace the three `BOOK TITLE`s.
3. From the Sgeulai export, copy `companion.json` into that folder.
4. Commit and push. The page is at `jeffreypotts.ca/companion/my-book/`.

## Updating a book

Export again from Sgeulai and replace that folder's `companion.json`. Nothing
else changes.

## Shared files

`companion.js` and `companion.css` are Sgeulai's renderer, shared by every
book. The site's colours and fonts are applied in each page's `--sgc-*`
variables, so a newer export's `companion.js`/`companion.css` can be dropped
in over these without losing the look.

# Reader RAG evaluation fixtures

Fixture provenance is machine-readable in `manifest.json`. Every eval run
checks both the SHA-256 and byte size before uploading or ingesting a book.

`alice-in-wonderland.epub` is a deterministic text-only EPUB built from the
pinned Standard Ebooks source revision. Illustration files and image elements
were removed to keep the required CI fixture small; the text, chapter structure,
metadata, navigation, and styles are retained.

`frankenstein.epub` is the compatible EPUB downloaded from the official
Standard Ebooks URL recorded in the manifest. Standard Ebooks dedicates its
contributions to the worldwide public domain under CC0 1.0; consult each source
repository's `LICENSE.md` for the complete notice.

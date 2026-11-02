---
title: Comprehensive Markdown and Obsidian fixture
aliases:
  - Markdown fixture
  - Obsidian fixture
tags:
  - fixture
  - markdown/obsidian
cssclasses:
  - wide-page
status: test
published: false
count: 3
date: 2026-09-20
---

# Actual heading

intro selection text

Plain text with **bold**, *italic*, ***bold italic***, ~~strikethrough~~, ==highlight==, `inline code`, and an escaped \*literal asterisk\*.

Internal links: [[Target]], [[Target|aliased target]], [[#Second level]], and [[#^fixture-block]].

Markdown links: [external link](https://example.com "Example"), <https://example.com/autolink>, and <tester@example.com>.

Images: ![Markdown pixel](pixel.svg) and ![[pixel.svg]].

| Name | Value |
| :--- | ---: |
| first | 1 |
| inline | `table code` |

```js
# fake heading
const value = 1;
```

Setext title
------------

- one
- two

before %% private %% after

end paragraph

## Second level

### Third level

#### Fourth level

##### Fifth level

###### Sixth level

Paragraph with a hard break  
and a following line.

> A regular blockquote with **strong text**.
>
> > A nested blockquote.

> [!NOTE]+ Expandable callout
> Callout body with [[Target|a wiki link]] and `inline code`.

- [ ] Open task
- [x] Completed task
  - Nested bullet
    1. Nested ordered item
    2. Second ordered item

1. First ordered item
2. Second ordered item

---

Inline math $E = mc^2$ and block math:

$$
\int_0^1 x^2\,dx = \frac{1}{3}
$$

```mermaid
flowchart LR
  A[Start] --> B[Finish]
```

    indented code block
    with a second line

Footnote reference[^fixture-note] and inline footnote^[Inline footnote text].

[^fixture-note]: Footnote definition with **formatting**.

HTML passthrough: <kbd>Ctrl</kbd> + <kbd>K</kbd> and <mark>marked HTML</mark>.

Obsidian tags: #fixture #nested/tag.

This paragraph owns a block identifier. ^fixture-block

Embedded heading: ![[Target#Target heading]].


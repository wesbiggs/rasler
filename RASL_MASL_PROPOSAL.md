# RASL Path Resolution via MASL

## Summary

This proposed specification update (in discussion as [dasl.ing #101](https://github.com/darobin/dasl.ing/issues/101)) defines how the path component of a RASL URL can resolve to a resource described in a MASL document, covering both modes:

- **Single Mode**: path `/` resolves to the `src` resource, with HTTP metadata taken from the document root.
- **Bundle Mode**: any path (including `/`) is looked up in the `resources` map, returning the matching `src` resource with its associated metadata.

Path resolution is specified as server behaviour at the `/.well-known/rasl/` endpoint. When a path is present in the request (including the trailing-slash form that produces path `/`), the server now returns the addressed resource rather than the raw MASL document bytes. This is a breaking change for callers that retrieve a MASL CID using a path-bearing URL and expect the document itself; callers using the path-free form `/.well-known/rasl/{cid}` are unaffected.

The proposal also defines how server-mapped resources (ordinary HTTPS URLs whose content is backed server-side by a MASL document) can expose the information necessary for clients to perform full CID-based verification, using general purpose HTTP integrity headers.

RASLer implements this approach. Deployers should be aware that it is subject to revision.

---

## Background

The [RASL](https://dasl.ing/rasl.html) spec currently reserves the URL path component for future use:

> "Implementations should ignore paths in RASL URLs. They may be used in a future iteration of this specification."

The [MASL](https://dasl.ing/masl.html) spec defines DRISL mappings for both (1) Bundle Mode — a `resources` map whose keys are root-relative paths and whose values are metadata objects each containing a `src` CID pointing to the actual resource, and (2) Single Mode — a `src` CID and HTTP metadata at the document root, wrapping exactly one resource.

A DASL [CID](https://dasl.ing/cid.html) embeds a SHA-256 hash at a fixed offset in its decoded bytes: a 4-byte prefix (version, codec, hash-function identifier, hash-length) followed by 32 hash bytes. This hash is computed over the raw, unencoded resource bytes, making it directly comparable to the value carried by the `Unencoded-Digest` HTTP header (draft-ietf-httpbis-unencoded-digest, link at end), which conveys a digest of content with no content codings applied.

---

## Design Goals

1. Any path in a RASL URL — including `/` — resolves against the `resources` map when the CID addresses a MASL Bundle Mode document, or to the `src` resource when the CID addresses a MASL Single Mode document. In both cases, HTTP metadata (content type, etc.) is drawn from the appropriate MASL fields.
2. A path of `/` on a non-MASL CID returns raw bytes, unchanged from current behaviour.
3. A non-trivial path on a non-MASL CID, or any non-`/` path on a Single Mode document, is an explicit failure.
4. Path resolution is defined normatively as server behaviour at the `/.well-known/rasl/` endpoint. The server always includes `Unencoded-Digest` in responses, enabling clients to verify data integrity and, combined with the MASL document, full path authenticity.
5. Server-mapped resources (ordinary HTTPS URLs backed by a MASL document) optionally expose the same verification information via `Unencoded-Digest` and `Link: rel="duplicate"`, enabling RASL-aware clients to perform the same verification without requiring prior knowledge of any CID.

---

## Proposed Spec Changes

### RASL

#### 1. Parse a RASL URL

In the current algorithm, step 3 reads the `host` part as *cid* and step 6 returns *cid* and *hints*. Add extraction of the path:

- After step 3, add:
  > Read the `pathname` part of the parsed URL and store that in *path*. If *path* is the empty string, set *path* to `/`.

- Update step 6 to:
  > Return the URL's parts as well as *cid*, *path*, and *hints*.

#### 2. Fetch a RASL URL — constructing request URLs

In step 2a, change the request URL construction from:

> `https://` + hint + `/.well-known/rasl/` + *cid*

to:

> `https://` + hint + `/.well-known/rasl/` + *cid* + *path*

Because *path* always begins with `/`, this produces URLs of the form `https://example.com/.well-known/rasl/bafk…bundle/picture.jpg` for non-root paths, and `https://example.com/.well-known/rasl/bafk…bundle/` for the root.

#### 3. Fetch a RASL URL — verification

Amend step 9 (CID verification) as follows:

> If the response does not include an `Unencoded-Digest` header containing a `sha-256` entry, fall back to producing a CID for the retrieved data and comparing it to *cid* directly.
>
> If the response includes `Unencoded-Digest: sha-256=:X:`, verify the response body by computing its SHA-256 hash and confirming it equals X. Then let H be the SHA-256 hash bytes embedded in *cid*:
>
> - If X equals H, the response is raw bytes of *cid*. Verification is complete.
> - If X does not equal H, the response is a path-resolved resource. Proceed to MASL document verification (step 4 below) to confirm that X is the correct resource hash for *path* within *cid*.

#### 4. Fetch a RASL URL — MASL document verification

Add a new step after step 9:

> If *path* identifies a MASL-resolved resource, and the MASL document for *cid* is not already cached and verified:
>
> 1. Fetch the MASL document by constructing requests using the same *hints* and the path-free URL `/.well-known/rasl/` + *cid* (no trailing slash or path suffix), which returns the raw document bytes.
> 2. Verify the retrieved MASL document's SHA-256 hash against the hash embedded in *cid*.
> 3. Cache the verified document keyed by *cid*.
>
> Then confirm the path mapping against the `Unencoded-Digest` sha-256 value X:
>
> - **Bundle Mode** (document has a `resources` map): confirm that `resources[`*path*`].src` encodes a SHA-256 hash equal to X.
> - **Single Mode** (document has `src`, no `resources`): *path* must be `/`; confirm that the root `src` CID encodes a SHA-256 hash equal to X.
>
> If either check fails, return failure.
>
> The MASL document for a given *cid* is immutable (content-addressed) and may be cached indefinitely. After the first verification, subsequent fetches of any path within the same document require no re-fetch of the MASL document.

#### 5. Fetch a RASL URL — media type

Amend step 6 to:

> If the server provided a `Content-Type` response header, use that value. Otherwise set the media type to `application/octet-stream`. (A path-resolved response will carry the content type from the relevant MASL metadata; a raw-bytes response may or may not, depending on whether the server applied content negotiation. Either way, the content type plays no role in verification.)

#### 6. New subsection: Serving path requests

Add a subsection to "Fetching RASL" titled **Serving path requests**:

> A server handling `GET /.well-known/rasl/{cid}/{path}` must use the following steps:
>
> 1. Retrieve the content at *cid* and verify it hashes to *cid*.
> 2. Attempt to parse the content as a DRISL map and classify it:
>    - **Not a DRISL map**: if *path* is `/`, serve the raw bytes as `application/octet-stream` with `Unencoded-Digest: sha-256=:X:` where X is the SHA-256 hash of the raw bytes (identical to the hash embedded in *cid*). Otherwise return `404 Not Found`.
>    - **MASL Bundle Mode** (DRISL map with a `resources` key whose value is a map): continue to step 3.
>    - **MASL Single Mode** (DRISL map with a `src` key containing a tag 42 CID, but no `resources` key): if *path* is `/`, let *resource-cid* be the `src` CID and let *entry* be the MASL document root itself, then continue to step 7. If *path* is not `/`, return `404 Not Found`.
>    - **Other DRISL map** (neither `resources` nor `src`): treat as "not a DRISL map" above.
> 3. Let *resources* be the value of the `resources` key.
> 4. Look up *path* in *resources*. If *path* is not present, return `404 Not Found`.
> 5. Let *entry* be the value at *resources*[*path*]. If *entry* is not a map or does not have a `src` key containing a tag 42 CID, return `500 Internal Server Error`.
> 6. Let *resource-cid* be the tag 42 CID from *entry*.
> 7. Retrieve the bytes for *resource-cid*. If unavailable, return `502 Bad Gateway`. The server should prefer blocks from any CAR body associated with *cid* before making an outbound request.
> 8. Set `Content-Type` to the value of `content-type` in *entry*, if present. For Single Mode, *entry* is the MASL document root, so `content-type` is a root-level field; for Bundle Mode it is a field within the `resources` entry.
> 9. Set `Unencoded-Digest: sha-256=:X:` where X is the base64-encoded SHA-256 hash bytes extracted from *resource-cid*. (No additional computation is required; the hash is already encoded in the CID.)
> 10. Set any other supported MASL HTTP header fields from *entry*.
> 11. Return the bytes of *resource-cid*.
>
> The `Unencoded-Digest` header in step 9 allows clients to verify the response body and to cross-check against the MASL document without re-fetching the full bundle. Its sha-256 value is derived directly from *resource-cid* and requires no additional hashing by the server.

#### 7. RASL Pathing section

Replace the current placeholder ("Implementations should ignore paths in RASL URLs. They may be used in a future iteration of this specification.") with:

> When the CID in a RASL URL addresses a MASL document, the path component selects a resource within that document:
>
> - **Bundle Mode**: the path is looked up in the `resources` map; the matching `src` resource is returned. The query string is ignored.
> - **Single Mode**: only path `/` is valid and resolves to the `src` resource. Any other path is a failure (`404 Not Found`).
>
> When the CID does not address a MASL document, path `/` returns the raw bytes of the CID. Any other path is a failure.
>
> Path resolution is defined as server behaviour at the `/.well-known/rasl/` endpoint; see the **Serving path requests** subsection. Client verification is described in **Fetch a RASL URL — verification** and **Fetch a RASL URL — MASL document verification**.
>
> The path-free URL form (`/.well-known/rasl/{cid}` with no trailing slash or path suffix) always returns raw bytes for the CID and is unaffected by path resolution.

---

### MASL

#### 1. Normative cross-reference to RASL

Add to the "Single or Multiple Resources" section, covering both modes:

> When a MASL document is addressed by a RASL URL, any path component — including `/` — is resolved as described in the RASL specification ([[rasl]]):
>
> - **Bundle Mode**: the path is looked up in the `resources` map. The query string is ignored, consistent with MASL's existing rule.
> - **Single Mode**: only the path `/` is valid; it resolves to the `src` resource, with HTTP metadata taken from the document root. Any other path is a failure.
>
> In both modes, the `content-type` and other supported HTTP header fields are taken from the relevant MASL metadata object and set on the HTTP response.

#### 2. Server-mapped resources

Add a new subsection titled **Server-mapped resources**:

> A MASL document (Single or Bundle Mode) may be published such that an ordinary HTTPS server maps its resources to human-readable URLs. Two independent choices are involved:
>
> **Mount point** — the URL prefix at which the MASL document is mounted. This may be the root of a domain, a path prefix within a domain, or a subdomain. The MASL path for any resource is the portion of the URL after the mount point, not the full URL path on the server:
>
> | Mount point | Resource `/a/b/c.html` served at |
> |---|---|
> | `https://www.example.com/` | `https://www.example.com/a/b/c.html` |
> | `https://www.example.com/section/subsection/` | `https://www.example.com/section/subsection/a/b/c.html` |
> | `https://docs.example.com/` | `https://docs.example.com/a/b/c.html` |
>
> **RASL host** — the host at which the RASL endpoint (`/.well-known/rasl/`) is available. This does not have to be the same host as the mount point. The RASL endpoint may be on the same server, on a different subdomain, or on an entirely separate host (e.g. a dedicated RASL hosting service or CDN). The host in the `Link` URL functions as a RASL hint in the same sense as hints in a `rasl://` URL — the client may use it or any other known source.
>
> When a server maps a MASL document this way, it should include the following headers on responses for server-mapped resources, to enable RASL-aware clients to perform full CID-based verification:
>
> ```http
> Unencoded-Digest: sha-256=:X:
> Link: <https://{rasl-host}/.well-known/rasl/{masl-cid}/a/b/c.html>; rel="duplicate"
> ```
>
> where X is the base64-encoded SHA-256 hash of the unencoded response body, identical to the hash embedded in the resource's `src` CID in the MASL `resources` map (Bundle Mode) or root `src` field (Single Mode), and *rasl-host* is whatever host serves the `/.well-known/rasl/` endpoint for this content.
>
> The path in the `Link` URL is always the MASL resource path (relative to the mount point), not the full URL path on the serving host. The `Link` header is therefore identical regardless of which mount point or serving host is used — it is determined solely by the MASL document, its CID, and the chosen RASL host. A client does not need to know the mount point; the `Link` URL provides all information needed for verification.
>
> The `Link: rel="duplicate"` header is what makes these two headers useful together. Without it, `Unencoded-Digest` tells the client the content hash but gives no indication of which MASL document to verify it against. The `Link` URL contains the MASL CID in its path, allowing a RASL-aware client to:
>
> 1. Extract *masl-cid*, *rasl-host*, and *masl-path* from the `Link` URL. *masl-path* is the portion of the URL path after the CID (e.g. `/a/b/c.html`); it is the MASL resource path relative to the mount point, not the full URL path on the serving host.
> 2. Fetch and verify the MASL document at `https://`*rasl-host*`/.well-known/rasl/`*masl-cid* (no trailing slash).
> 3. For Bundle Mode: confirm that `resources[`*masl-path*`].src` encodes a SHA-256 hash equal to the `Unencoded-Digest` value. For Single Mode: confirm that the root `src` CID encodes a SHA-256 hash equal to the `Unencoded-Digest` value.
>
> After step 2, the MASL document is cached and verification of any other resource served from the same MASL document — regardless of mount point or serving host — requires only step 3.
>
> Neither header is mandatory for serving mapped resources. A server that omits them, however, provides no path for CID verification; clients fall back to ordinary HTTPS trust. A server that provides `Unencoded-Digest` without `Link: rel="duplicate"` provides data integrity checking but not path authenticity.

---

## Examples

### RASL well-known endpoint

Request:

```http
GET /.well-known/rasl/bafk…bundle/a/b/c.html HTTP/1.1
Host: www.example.com
Want-Unencoded-Digest: sha-256=10
```

Response:

```http
HTTP/1.1 200 OK
Content-Type: text/html
Unencoded-Digest: sha-256=:d435Qo+nKZ+gLcUHn7GQtQ72hiBVAgqoLsZnZPiTGPk=:

[bytes of /a/b/c.html]
```

Client verification:

1. SHA-256 of response body must equal `d435Qo+…` — verifies data integrity.
2. Fetch `/.well-known/rasl/bafk…bundle` (no trailing slash) if not cached. Verify it hashes to `bafk…bundle`. (One fetch, can be cached indefinitely.)
3. Extract SHA-256 bytes from `resources["/a/b/c.html"].src` CID. Must equal `d435Qo+…` — verifies path authenticity.

No trust in the server is required beyond the initial TLS connection.

### Server-mapped resource

Request:

```http
GET /a/b/c.html HTTP/1.1
Host: www.example.com
```

Response:

```http
HTTP/1.1 200 OK
Content-Type: text/html
Unencoded-Digest: sha-256=:d435Qo+nKZ+gLcUHn7GQtQ72hiBVAgqoLsZnZPiTGPk=:
Link: <https://www.example.com/.well-known/rasl/bafk…bundle/a/b/c.html>; rel="duplicate"

[bytes of /a/b/c.html]
```

The `Unencoded-Digest` value is identical to the `/.well-known/rasl/` response above — it is derived from the resource CID and does not change between the two serving paths.

Client verification (RASL-aware client):

1. SHA-256 of response body must equal `d435Qo+…`.
2. Parse the `Link` URL to extract `bafk…bundle`.
3. Fetch `/.well-known/rasl/bafk…bundle` (no trailing slash). Verify it hashes to `bafk…bundle`. (Cached after first fetch; amortized across the whole site visit.)
4. Confirm `resources["/a/b/c.html"].src` encodes SHA-256 `d435Qo+…`.

A non-RASL-aware client ignores both headers and relies on TLS as today.

### Single Mode MASL document

A MASL Single Mode document with CID `bafk…single` wraps one PDF:

```json
{
  "src": { "$link": "bafk…pdf" },
  "content-type": "application/pdf",
  "content-disposition": "inline; filename=\"report.pdf\""
}
```

`GET /.well-known/rasl/bafk…single/`:

```http
HTTP/1.1 200 OK
Content-Type: application/pdf
Content-Disposition: inline; filename="report.pdf"
Unencoded-Digest: sha-256=:d435Qo+nKZ+gLcUHn7GQtQ72hiBVAgqoLsZnZPiTGPk=:

[bytes of report.pdf]
```

A non-`/` path on the same CID returns `404 Not Found` — there is no `resources` map to look up further paths in.

For server-mapping, `https://www.example.com/report.pdf` serving the same bytes would include:

```http
Unencoded-Digest: sha-256=:d435Qo+nKZ+gLcUHn7GQtQ72hiBVAgqoLsZnZPiTGPk=:
Link: <https://www.example.com/.well-known/rasl/bafk…single/>; rel="duplicate"
```

Client verification (RASL-aware client):

1. SHA-256 of response body must equal `d435Qo+…`.
2. Parse the `Link` URL to extract `bafk…single` (*masl-cid*) and *rasl-host*.
3. Fetch `/.well-known/rasl/bafk…single` (no trailing slash). Verify it hashes to `bafk…single`. (Cached after first fetch.)
4. Confirm the root `src` CID encodes SHA-256 `d435Qo+…`.

A non-RASL-aware client ignores both headers and relies on TLS as today.

### Non-MASL CID with non-trivial path

```http
GET /.well-known/rasl/bafk…image/picture.jpg HTTP/1.1

HTTP/1.1 404 Not Found
```

`bafk…image` is a raw JPEG, not a MASL document (neither Bundle nor Single Mode).

### Root path on a bundle

```http
GET /.well-known/rasl/bafk…bundle/ HTTP/1.1

HTTP/1.1 200 OK
Content-Type: text/html
Unencoded-Digest: sha-256=:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=:

[bytes of the resource at resources["/"]]
```

Prior to this proposal, this request would have returned the raw MASL document bytes. **This is the breaking change:** any CID pointing to a MASL document (Bundle or Single Mode) now returns the addressed resource at path `/` rather than the document itself — `resources["/"]` for Bundle Mode, the `src` resource for Single Mode.

---

## Breaking Change Discussion

The only clients affected are those that construct a RASL URL with a non-empty path component, where the CID points to a MASL document (Single or Bundle Mode), and expect to receive the raw MASL document bytes. To retrieve raw MASL document bytes, callers must omit the trailing `/` from the well-known URL (i.e. `/.well-known/rasl/{cid}` without a path suffix), which is outside the scope of this proposal and continues to behave as today.

Any CID that does not address a MASL document is entirely unaffected: path `/` continues to return raw bytes for those CIDs.

---

## References

`Unencoded-Digest` is specified in an active IETF httpbis working group draft proposal to update [RFC 9530](https://www.rfc-editor.org/info/rfc9530/) (Digest Fields, 2024) and is not yet an RFC. It addresses a weakness of RFC 9530's `Repr-Digest` header due to variable content encodings. See [draft-ietf-httpbis-unencoded-digest](https://httpwg.org/http-extensions/unencode-update-acknowledgements/draft-ietf-httpbis-unencoded-digest.html).

`Link: rel="duplicate"` is defined in [RFC 6249](https://www.rfc-editor.org/info/rfc6249/) (Metalink/HTTP: Mirrors and Hashes, 2011).

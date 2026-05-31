# RASLer use cases

RASLer supports several distinct deployment patterns depending on how content is stored, how it is addressed, and whether human-readable URLs are needed. The axes that drive the configuration choices are:

- **Content origin** — filesystem (static roots) vs. uploaded (API or CAR)
- **Access method** — RASL protocol (CID-addressed) vs. virtual host (hostname-addressed)
- **Mutability** — auto-updating on file changes vs. frozen snapshot
- **Scope** — standalone node vs. multi-node network

---

## RASL protocol access

Content is retrieved via `GET /.well-known/rasl/:cid`. Clients must know the CID. No virtual host or DNS configuration required.

### Raw object hosting

Store and serve opaque bytes by CID with no MASL wrapper. Suitable for machine-to-machine distribution where the CID is known out of band — build artifacts, dataset chunks, binary blobs.

**Config:** upload via `/upload` (raw file); pin to prevent eviction.  
**Access:** `GET /.well-known/rasl/:dataCid` returns raw bytes as `application/octet-stream`.

### Single-file MASL hosting

A single file wrapped with a MASL document that records its name and content type. Clients can retrieve via the MASL CID (gets metadata and content-type) or the data CID (raw bytes).

**Config:** upload via `/upload` (raw file); a single-mode MASL is generated automatically.  
**Access:** `GET /.well-known/rasl/:maslCid` returns the MASL; `GET /.well-known/rasl/:dataCid` returns the file with its content-type.

### Bundle MASL path navigation

A multi-file bundle MASL with a `resources` map. Clients navigate by path suffix — useful for distributing a website, documentation set, or software package via the RASL protocol directly.

**Config:** upload a CAR file containing a bundle MASL and all linked data blocks.  
**Access:** `GET /.well-known/rasl/:maslCid/path/to/file` resolves the path against the bundle's resource map.

### Pinned artifact registry

CIDs pinned indefinitely so they are never evicted. CI/CD pipelines and downstream tools consume content by CID; immutability is guaranteed by the content-addressing.

**Config:** upload content, then `POST /pin` with the relevant CIDs.  
**Access:** standard RASL retrieval; combine with bundle MASL for path-based access if needed.

---

## Virtual host access

The `Host:` header is mapped to a bundle MASL, and paths are resolved against the MASL's resource map. Clients use ordinary URLs; no CID knowledge required.

### Static root website

A filesystem directory is indexed on startup and served at a hostname. The MASL is regenerated automatically whenever the directory is re-indexed (e.g., after a deploy), so the served content updates without a server restart. `index.html` files are aliased to their parent directory path.

**Config:** `MOUNT_POINTS=example.com:/var/www/html`  
**Access:** `GET /` on `example.com` resolves against the current bundle MASL for that directory.  
**Notes:** Files are streamed directly from disk; no bytes are copied to the blob store. Use `STATIC_MAX_HISTORY` to limit how many old MASL versions remain pinned.

### Immutable snapshot website

A CAR bundle is uploaded and a hostname is pointed at its MASL CID via the operator API. The served content is frozen at that CID until the operator explicitly updates the mapping. The old MASL CID remains reachable by RASL clients throughout.

**Config:** `POST /upload` (CAR), then `PUT /mount-points/example.com` with `{ maslCid }`.  
**Access:** `GET /path` on `example.com` resolves against the pinned bundle MASL.

### Blue/green or staged rollout

Two CAR builds are uploaded and their MASL CIDs are retained. A single `PUT /mount-points/:hostname` call atomically switches the hostname from one build to the other. During the transition, the old MASL CID is still reachable via RASL for in-flight requests.

**Config:** upload build A and build B as separate CARs; map the hostname to A initially; switch to B by calling `PUT /mount-points/:hostname` with B's `maslCid`.  
**Access:** identical to immutable snapshot; the swap is invisible to browser clients.

### Multi-tenant hosting

Multiple hostnames on a single node, each mapped to a different directory or MASL CID. Static root and runtime-mapped hostnames can coexist.

**Config:** `MOUNT_POINTS=site1.com:/var/www/site1,site2.com:/var/www/site2` for filesystem-backed tenants; `PUT /mount-points/site3.com` for an uploaded CAR tenant.  
**Access:** each hostname resolves independently; RASL access by CID works for all content simultaneously.

### Static root with runtime override

A directory is configured as a static root so it auto-updates on re-index. A `PUT /mount-points/:hostname` call freezes a specific version (e.g., to hold production stable while a new build is tested). Removing the runtime mapping with `DELETE /mount-points/:hostname` returns the hostname to auto-update behavior.

**Config:** `MOUNT_POINTS=example.com:/var/www/html`, then `PUT /mount-points/example.com` to pin a snapshot.  
**Access:** the runtime mapping takes priority over the static root mapping while it is set.

---

## Operational and network patterns

### Read replica

Content is authored on a primary node, exported as CAR files, and imported and pinned on one or more secondary nodes for redundancy or geographic distribution.

**Config:** on primary, export content via `GET /.well-known/rasl/:cid` or CAR tooling; on replica, `POST /upload` the CAR and `POST /pin` the relevant CIDs.

### Offline / air-gapped deployment

Content is bundled as a CAR on a connected machine, transferred physically (or via a one-way channel), and served in an isolated environment. The CID-addressed content can be verified on arrival.

**Config:** build a CAR offline; copy to the target node; `POST /upload` the CAR; optionally map a virtual host for browser access.

# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.0] - 2026-07-13

### Added

- Enterprise dark-mode UI with light theme toggle (persisted in localStorage)
- Sidebar navigation layout replacing header button bar
- Toast notification system replacing all alert/confirm dialogs
- Responsive design with mobile breakpoints (sidebar hidden, compact layout)
- Incremental message rendering (no full re-render on each SSE event)

### Changed

- Server: chunk uploads now use disk storage instead of memory (multer.diskStorage)
- Server: express.json body limit set to 10MB
- Server: graceful shutdown closes SSE clients and HTTP server
- Server: global error handler catches unhandled route errors
- Server: 404 handler for unmatched API endpoints
- Server: process-level uncaughtException/unhandledRejection guards

### Fixed

- Memory pressure on large multi-file uploads (chunks no longer buffered in RAM)
- Server crash on unhandled promise rejection or uncaught exception
- Stale connections on shutdown (SSE clients now properly closed)

## [1.1.0] - 2026-07-12

### Added

- File expiration presets (1h / 1d / 7d / never) on upload, with automatic
  cleanup of expired files and their chat messages.
- Batch ZIP download: select multiple files and download them as a single ZIP
  archive (server-side ZIP builder, up to 200 files per batch).
- File search / filter box in the chat message list.
- Image lightbox preview for image attachments.
- Download queue controls: pause all, resume all, delete all.

### Changed

- LAN download throughput optimizations: TCP_NODELAY on serving sockets, larger
  read buffer (256KB), 1MB send buffer, 5-minute socket timeout.
- Concurrent active downloads raised from 2 to 3.
- Download pause/resume/delete now guards against controller race conditions,
  preserving partial data for clean resume.

### Fixed

- Download task pause/resume race condition that could restart a download from
  zero instead of resuming.
- Read-stream leaks on aborted downloads (streams are now destroyed on close).

## [1.0.0] - 2026-06-21

### Added

- Standalone LAN chat and file transfer web application.
- Chunked upload with resume and automatic retry.
- Server-Sent Events live sync across devices.
- Quick-connect QR code (locally generated SVG).
- Windows tray background launcher with status panel.
- Storage management with retention and capacity policies.
- Device alias management.
- Automated regression tests (JSDOM + Playwright/Edge).
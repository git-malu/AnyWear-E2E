# Tauri Native FS Image Cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a native filesystem image cache for the Tauri client to instantly load previously fetched S3 images.

**Architecture:** Use `@tauri-apps/plugin-fs` to download and store images in the app's local data directory, serving them via `convertFileSrc` on cache hits.

**Tech Stack:** React, Tauri v2, `@tauri-apps/plugin-fs`

---

### Task 1: Write the ADR Document

**Files:**
- Create: `AnyWear-Meta/architecture/ADR/0003-tauri-native-fs-image-cache.md`

- [ ] **Step 1: Write ADR content**
Create the ADR with the content previously approved in this thread.

- [ ] **Step 2: Commit**
```bash
cd AnyWear-Meta
git add architecture/ADR/0003-tauri-native-fs-image-cache.md
git commit -m "docs: add ADR 0003 for tauri native fs image cache"
```

### Task 2: Install Tauri FS Plugins

**Files:**
- Modify: `AnyWear-Client/package.json`
- Modify: `AnyWear-Client/src-tauri/Cargo.toml`
- Modify: `AnyWear-Client/src-tauri/src/lib.rs` (to initialize plugin)
- Modify: `AnyWear-Client/src-tauri/capabilities/default.json` (or `tauri.conf.json`)

- [ ] **Step 1: Install frontend dependency**
Run: `cd AnyWear-Client && pnpm add @tauri-apps/plugin-fs`

- [ ] **Step 2: Install Rust dependency**
Run: `cd AnyWear-Client/src-tauri && cargo add tauri-plugin-fs`

- [ ] **Step 3: Register plugin in Rust**
Update `src-tauri/src/lib.rs` to add `.plugin(tauri_plugin_fs::init())` to the builder.

- [ ] **Step 4: Update Capabilities**
Update the capabilities configuration (usually in `src-tauri/capabilities/default.json` or `tauri.conf.json`) to allow fs read, write, and mkdir on `$APPDATA/*` and `$APPDATA/cache/images/*`.

- [ ] **Step 5: Commit**
```bash
cd AnyWear-Client
git add package.json pnpm-lock.yaml src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/lib.rs src-tauri/capabilities/default.json
git commit -m "chore: install and configure tauri fs plugin"
```

### Task 3: Create `CachedImage` Component

**Files:**
- Create: `AnyWear-Client/src/components/CachedImage.tsx`

- [ ] **Step 1: Write component code**
```tsx
import { useState, useEffect } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { appDataDir, join } from '@tauri-apps/api/path';
import { exists, mkdir, writeFile } from '@tauri-apps/plugin-fs';
import { convertFileSrc } from '@tauri-apps/api/core';

interface CachedImageProps extends React.ImgHTMLAttributes<HTMLImageElement> {
  src: string;
  cacheKey: string;
}

const activeDownloads = new Map<string, Promise<string>>();

export default function CachedImage({ src, cacheKey, ...props }: CachedImageProps) {
  const [imgSrc, setImgSrc] = useState<string | null>(null);

  useEffect(() => {
    let isMounted = true;

    async function loadCachedImage() {
      if (!isTauri()) {
        if (isMounted) setImgSrc(src);
        return;
      }

      try {
        const baseDir = await appDataDir();
        const cacheDir = await join(baseDir, 'cache', 'images');
        const filePath = await join(cacheDir, `${cacheKey}.jpg`);

        const fileExists = await exists(filePath);

        if (fileExists) {
          if (isMounted) setImgSrc(convertFileSrc(filePath));
          return;
        }

        if (activeDownloads.has(cacheKey)) {
          const path = await activeDownloads.get(cacheKey);
          if (path && isMounted) setImgSrc(convertFileSrc(path));
          return;
        }

        const downloadPromise = (async () => {
          const dirExists = await exists(cacheDir);
          if (!dirExists) {
            await mkdir(cacheDir, { recursive: true });
          }

          const response = await fetch(src);
          if (!response.ok) throw new Error('Network response was not ok');
          const buffer = await response.arrayBuffer();
          await writeFile(filePath, new Uint8Array(buffer));
          
          return filePath;
        })();

        activeDownloads.set(cacheKey, downloadPromise);
        const downloadedPath = await downloadPromise;
        activeDownloads.delete(cacheKey);

        if (isMounted) {
          setImgSrc(convertFileSrc(downloadedPath));
        }
      } catch (error) {
        console.error('Failed to load cached image:', error);
        if (isMounted) setImgSrc(src); // Fallback to network on error
        activeDownloads.delete(cacheKey);
      }
    }

    loadCachedImage();

    return () => {
      isMounted = false;
    };
  }, [src, cacheKey]);

  if (!imgSrc) return <div className={`animate-pulse bg-gray-200 ${props.className || ''}`}></div>;

  return <img src={imgSrc} {...props} />;
}
```

- [ ] **Step 2: Type check**
Run: `cd AnyWear-Client && pnpm tsc --noEmit`
Expected: PASS

- [ ] **Step 3: Commit**
```bash
cd AnyWear-Client
git add src/components/CachedImage.tsx
git commit -m "feat: add CachedImage component using tauri fs"
```

### Task 4: Integrate `CachedImage` in Application

**Files:**
- Modify: `AnyWear-Client/src/pages/wardrobe/WardrobePage.tsx`
- Modify: `AnyWear-Client/src/pages/wardrobe/ItemDetailsModal.tsx`

- [ ] **Step 1: Update WardrobePage**
Import `CachedImage`.
Replace `<img src={item.originalImageUrl} ... />` with `<CachedImage src={item.originalImageUrl} cacheKey={item.id} ... />`.

- [ ] **Step 2: Update ItemDetailsModal**
Import `CachedImage`.
Replace `<img src={item.originalImageUrl} ... />` with `<CachedImage src={item.originalImageUrl} cacheKey={item.id} ... />`.

- [ ] **Step 3: Type check**
Run: `cd AnyWear-Client && pnpm tsc --noEmit`
Expected: PASS

- [ ] **Step 4: Commit**
```bash
cd AnyWear-Client
git add src/pages/wardrobe/WardrobePage.tsx src/pages/wardrobe/ItemDetailsModal.tsx
git commit -m "feat: integrate CachedImage into wardrobe views"
```
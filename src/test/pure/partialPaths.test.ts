import * as assert from 'node:assert';
import type { FsDeps } from '../../pure/fsWalk';
import {
  findViewsRoot,
  partialCandidatePaths,
  partialCompletionCandidates,
  partialGlob,
  partialRootRelativeName,
  resolvePartialPath
} from '../../pure/partialPaths';

function deps(files: readonly string[], platform: NodeJS.Platform = 'linux'): FsDeps & { readonly asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    fileExists: (target) => {
      asked.push(target);
      return files.includes(target);
    },
    readFile: () => null,
    platform
  };
}

/** Like deps(), plus directory listings for the locale-variant fallback. */
function listingDeps(files: readonly string[], listings: Record<string, readonly string[]>, platform: NodeJS.Platform = 'linux'): FsDeps {
  return {
    fileExists: (target) => files.includes(target),
    readFile: () => null,
    readDirectory: (target) => listings[target] ?? null,
    platform
  };
}

const VIEW = '/repo/app/views/posts/show.html.slim';

suite('pure/partialPaths Test Suite', () => {
  suite('findViewsRoot', () => {
    test('should find the app/views containing the document', () => {
      assert.strictEqual(findViewsRoot(VIEW, '/repo', 'linux'), '/repo/app/views');
      assert.strictEqual(findViewsRoot('/repo/app/views/index.slim', '/repo', 'linux'), '/repo/app/views');
    });

    test('should find an engine or dummy app views root rather than an outer one', () => {
      assert.strictEqual(findViewsRoot('/repo/engines/blog/app/views/posts/show.slim', '/repo', 'linux'), '/repo/engines/blog/app/views');
      assert.strictEqual(findViewsRoot('/repo/spec/dummy/app/views/x.slim', '/repo', 'linux'), '/repo/spec/dummy/app/views');
    });

    // views has to be directly inside app, or app/assets/views and lib/views would match.
    test('should require the parent directory to be app', () => {
      assert.strictEqual(findViewsRoot('/repo/lib/views/x.slim', '/repo', 'linux'), null);
      assert.strictEqual(findViewsRoot('/repo/app/assets/views/x.slim', '/repo', 'linux'), null);
    });

    test('should stop at the workspace folder', () => {
      assert.strictEqual(findViewsRoot(VIEW, '/repo/app/views/posts', 'linux'), null);
    });

    // Unlike detectRails this walks past the folder: the predicate reads names only, so there is no
    // stray file in $HOME it could pick up, and a file opened outside any folder still resolves.
    test('should walk to the filesystem root without a workspace folder', () => {
      assert.strictEqual(findViewsRoot(VIEW, undefined, 'linux'), '/repo/app/views');
    });

    test('should return null when there is no app/views above the document', () => {
      assert.strictEqual(findViewsRoot('/repo/templates/x.slim', '/repo', 'linux'), null);
    });

    test('should work on win32 paths', () => {
      assert.strictEqual(findViewsRoot('C:\\repo\\app\\views\\posts\\show.slim', 'C:\\repo', 'win32'), 'C:\\repo\\app\\views');
    });
  });

  suite('partialCandidatePaths', () => {
    // Slim first because this is a Slim extension, then the document's own format, then html, then none.
    test('should order slim before erb and the document format before html', () => {
      assert.deepStrictEqual(partialCandidatePaths({ documentPath: VIEW, viewsRoot: '/repo/app/views', name: 'shared/foo' }, 'linux'), [
        '/repo/app/views/shared/_foo.html.slim',
        '/repo/app/views/shared/_foo.slim',
        '/repo/app/views/shared/_foo.html.erb',
        '/repo/app/views/shared/_foo.erb'
      ]);
    });

    test('should put the document format first when it is not html', () => {
      const lookup = { documentPath: '/repo/app/views/posts/index.turbo_stream.slim', viewsRoot: '/repo/app/views', name: 'shared/foo' };
      assert.deepStrictEqual(partialCandidatePaths(lookup, 'linux'), [
        '/repo/app/views/shared/_foo.turbo_stream.slim',
        '/repo/app/views/shared/_foo.html.slim',
        '/repo/app/views/shared/_foo.slim',
        '/repo/app/views/shared/_foo.turbo_stream.erb',
        '/repo/app/views/shared/_foo.html.erb',
        '/repo/app/views/shared/_foo.erb'
      ]);
    });

    test('should treat a document with no extension at all as html', () => {
      const lookup = { documentPath: '/repo/app/views/posts/template', viewsRoot: '/repo/app/views', name: 'shared/foo' };
      assert.strictEqual(partialCandidatePaths(lookup, 'linux')[0], '/repo/app/views/shared/_foo.html.slim');
    });

    test('should treat a document with no format as html', () => {
      const lookup = { documentPath: '/repo/app/views/posts/index.slim', viewsRoot: '/repo/app/views', name: 'shared/foo' };
      assert.deepStrictEqual(partialCandidatePaths(lookup, 'linux'), [
        '/repo/app/views/shared/_foo.html.slim',
        '/repo/app/views/shared/_foo.slim',
        '/repo/app/views/shared/_foo.html.erb',
        '/repo/app/views/shared/_foo.erb'
      ]);
    });

    // A bare name is relative to the template's own directory, then to the inherited application prefix.
    test('should look beside the document and then in application for a bare name', () => {
      const paths = partialCandidatePaths({ documentPath: VIEW, viewsRoot: '/repo/app/views', name: 'sidebar' }, 'linux');
      assert.deepStrictEqual(paths.slice(0, 2), ['/repo/app/views/posts/_sidebar.html.slim', '/repo/app/views/posts/_sidebar.slim']);
      assert.ok(paths.includes('/repo/app/views/application/_sidebar.html.slim'), paths.join(' '));
      assert.ok(paths.indexOf('/repo/app/views/posts/_sidebar.erb') < paths.indexOf('/repo/app/views/application/_sidebar.html.slim'));
    });

    test('should fall back to the document directory when there is no views root', () => {
      assert.deepStrictEqual(partialCandidatePaths({ documentPath: '/site/pages/index.slim', viewsRoot: null, name: 'shared/foo' }, 'linux'), [
        '/site/pages/shared/_foo.html.slim',
        '/site/pages/shared/_foo.slim',
        '/site/pages/shared/_foo.html.erb',
        '/site/pages/shared/_foo.erb'
      ]);
      assert.deepStrictEqual(partialCandidatePaths({ documentPath: '/site/pages/index.slim', viewsRoot: null, name: 'foo' }, 'linux'), [
        '/site/pages/_foo.html.slim',
        '/site/pages/_foo.slim',
        '/site/pages/_foo.html.erb',
        '/site/pages/_foo.erb'
      ]);
    });

    // Rails prepends `_` to a render-call name unconditionally: `render 'shared/_foo'` looks up
    // `__foo`, never `_foo`. Mirroring that keeps navigation honest about a line that would raise
    // MissingTemplate at runtime.
    test('should prepend the underscore even to a name that already has one', () => {
      const paths = partialCandidatePaths({ documentPath: VIEW, viewsRoot: '/repo/app/views', name: 'shared/_foo' }, 'linux');
      assert.strictEqual(paths[0], '/repo/app/views/shared/__foo.html.slim');
      assert.ok(!paths.includes('/repo/app/views/shared/_foo.html.slim'), paths.join(' '));
    });

    test('should refuse names that cannot be a partial', () => {
      for (const name of ['', 'shared/#{x}', 'a b', '/shared/foo', '../secrets', '..', 'shared\\foo']) {
        assert.deepStrictEqual(partialCandidatePaths({ documentPath: VIEW, viewsRoot: '/repo/app/views', name }, 'linux'), [], name);
      }
    });

    test('should build win32 paths on win32', () => {
      const lookup = { documentPath: 'C:\\repo\\app\\views\\posts\\show.html.slim', viewsRoot: 'C:\\repo\\app\\views', name: 'shared/foo' };
      assert.strictEqual(partialCandidatePaths(lookup, 'win32')[0], 'C:\\repo\\app\\views\\shared\\_foo.html.slim');
    });
  });

  suite('resolvePartialPath', () => {
    test('should return the first candidate that exists', () => {
      const files = deps(['/repo/app/views/shared/_foo.slim', '/repo/app/views/shared/_foo.html.erb']);
      const resolved = resolvePartialPath({ documentPath: VIEW, viewsRoot: '/repo/app/views', name: 'shared/foo' }, files);
      assert.strictEqual(resolved, '/repo/app/views/shared/_foo.slim');
    });

    test('should stop asking once a candidate exists', () => {
      const files = deps(['/repo/app/views/shared/_foo.html.slim']);
      resolvePartialPath({ documentPath: VIEW, viewsRoot: '/repo/app/views', name: 'shared/foo' }, files);
      assert.deepStrictEqual(files.asked, ['/repo/app/views/shared/_foo.html.slim']);
    });

    test('should fall back to the application prefix for a bare name', () => {
      const files = deps(['/repo/app/views/application/_flash.html.slim']);
      const resolved = resolvePartialPath({ documentPath: VIEW, viewsRoot: '/repo/app/views', name: 'flash' }, files);
      assert.strictEqual(resolved, '/repo/app/views/application/_flash.html.slim');
    });

    test('should return null when nothing exists', () => {
      const resolved = resolvePartialPath({ documentPath: VIEW, viewsRoot: '/repo/app/views', name: 'nope/nope' }, deps([]));
      assert.strictEqual(resolved, null);
    });

    // The render call a Split to Partial of the name `__card` writes - and the label completion
    // offers for the file `__card.html.slim` - must resolve back to that file.
    test('should resolve an underscored name to its doubly underscored file', () => {
      const files = deps(['/repo/app/views/posts/__card.html.slim']);
      const resolved = resolvePartialPath({ documentPath: VIEW, viewsRoot: '/repo/app/views', name: 'posts/_card' }, files);
      assert.strictEqual(resolved, '/repo/app/views/posts/__card.html.slim');
    });

    // `render 'shared/_foo'` naming the file `_foo.html.slim` raises MissingTemplate at runtime;
    // resolving it here would let go to definition vouch for a broken line.
    test('should not resolve an underscored name to the file it misses at runtime', () => {
      const files = deps(['/repo/app/views/shared/_foo.html.slim']);
      assert.strictEqual(resolvePartialPath({ documentPath: VIEW, viewsRoot: '/repo/app/views', name: 'shared/_foo' }, files), null);
    });

    // A refused name must not reach the filesystem at all.
    test('should not touch the filesystem for a name it refuses', () => {
      const files = deps([]);
      assert.strictEqual(resolvePartialPath({ documentPath: VIEW, viewsRoot: '/repo/app/views', name: '../secrets' }, files), null);
      assert.deepStrictEqual(files.asked, []);
    });

    // Rails inserts locale and variant segments the fixed candidate list cannot enumerate, and the
    // completion side offers such files as plain `foo` - definition has to resolve what completion
    // inserted.
    test('should resolve a locale variant through the directory listing', () => {
      const files = listingDeps([], { '/repo/app/views/shared': ['_foo.en.html.slim'] });
      const resolved = resolvePartialPath({ documentPath: VIEW, viewsRoot: '/repo/app/views', name: 'shared/foo' }, files);
      assert.strictEqual(resolved, '/repo/app/views/shared/_foo.en.html.slim');
    });

    test('should prefer an exact candidate over the listing', () => {
      const files = listingDeps(['/repo/app/views/shared/_foo.html.slim'], {
        '/repo/app/views/shared': ['_foo.en.html.slim', '_foo.html.slim']
      });
      const resolved = resolvePartialPath({ documentPath: VIEW, viewsRoot: '/repo/app/views', name: 'shared/foo' }, files);
      assert.strictEqual(resolved, '/repo/app/views/shared/_foo.html.slim');
    });

    test('should rank listed variants by handler then format, ignoring other stems', () => {
      const files = listingDeps([], {
        '/repo/app/views/shared': ['_foobar.html.slim', '_foo.en.html.erb', '_foo.en.html.slim']
      });
      const resolved = resolvePartialPath({ documentPath: VIEW, viewsRoot: '/repo/app/views', name: 'shared/foo' }, files);
      assert.strictEqual(resolved, '/repo/app/views/shared/_foo.en.html.slim');
    });

    // The plain deps() fake has no readDirectory, which is the shape older FsDeps consumers pass.
    test('should stay null when the listing capability is absent', () => {
      const resolved = resolvePartialPath({ documentPath: VIEW, viewsRoot: '/repo/app/views', name: 'shared/foo' }, deps([]));
      assert.strictEqual(resolved, null);
    });
  });

  suite('partialGlob', () => {
    test('should search the whole views root recursively', () => {
      const input = { workspaceFolderPath: '/repo', viewsRoot: '/repo/app/views', documentDirectory: '/repo/app/views/posts' };
      assert.strictEqual(partialGlob(input, 'linux'), 'app/views/**/_*.{slim,erb}');
    });

    test('should search only the document directory without a views root', () => {
      const input = { workspaceFolderPath: '/repo', viewsRoot: null, documentDirectory: '/repo/templates' };
      assert.strictEqual(partialGlob(input, 'linux'), 'templates/_*.{slim,erb}');
    });

    test('should handle a base that is the workspace folder itself', () => {
      const input = { workspaceFolderPath: '/repo', viewsRoot: null, documentDirectory: '/repo' };
      assert.strictEqual(partialGlob(input, 'linux'), '_*.{slim,erb}');
    });

    test('should return null when the base is outside the workspace folder', () => {
      const input = { workspaceFolderPath: '/repo', viewsRoot: '/elsewhere/app/views', documentDirectory: '/elsewhere/app/views' };
      assert.strictEqual(partialGlob(input, 'linux'), null);
    });

    // A glob is always posix, whatever the platform the path came from.
    test('should emit forward slashes on win32', () => {
      const input = { workspaceFolderPath: 'C:\\repo', viewsRoot: 'C:\\repo\\app\\views', documentDirectory: 'C:\\repo\\app\\views\\posts' };
      assert.strictEqual(partialGlob(input, 'win32'), 'app/views/**/_*.{slim,erb}');
    });
  });

  suite('partialRootRelativeName', () => {
    test('should strip the base, the underscore and every extension', () => {
      assert.strictEqual(partialRootRelativeName('/repo/app/views/shared/_foo.html.slim', '/repo/app/views', 'linux'), 'shared/foo');
      assert.strictEqual(partialRootRelativeName('/repo/app/views/_foo.slim', '/repo/app/views', 'linux'), 'foo');
      assert.strictEqual(partialRootRelativeName('/repo/app/views/a/b/_c.turbo_stream.erb', '/repo/app/views', 'linux'), 'a/b/c');
    });

    test('should return null for a path outside the base', () => {
      assert.strictEqual(partialRootRelativeName('/elsewhere/_foo.slim', '/repo/app/views', 'linux'), null);
    });

    test('should emit forward slashes on win32, because the name is a Rails string', () => {
      assert.strictEqual(partialRootRelativeName('C:\\repo\\app\\views\\shared\\_foo.html.slim', 'C:\\repo\\app\\views', 'win32'), 'shared/foo');
    });

    test('should round-trip with partialCandidatePaths', () => {
      const first = partialCandidatePaths({ documentPath: VIEW, viewsRoot: '/repo/app/views', name: 'shared/foo' }, 'linux')[0] as string;
      assert.strictEqual(partialRootRelativeName(first, '/repo/app/views', 'linux'), 'shared/foo');
    });
  });

  suite('partialCompletionCandidates', () => {
    const VIEWS = '/repo/app/views';
    const HERE = '/repo/app/views/users';

    // A partial beside the document is written bare, which is how Rails resolves it.
    test('should label a sibling partial bare and a distant one root-relative', () => {
      const candidates = partialCompletionCandidates([`${HERE}/_row.slim`, `${VIEWS}/shared/_header.slim`], VIEWS, HERE, 'linux');
      assert.deepStrictEqual(
        candidates.map((c) => c.label),
        ['row', 'shared/header']
      );
    });

    test('should sort siblings ahead of everything else', () => {
      const candidates = partialCompletionCandidates([`${VIEWS}/shared/_header.slim`, `${HERE}/_row.slim`], VIEWS, HERE, 'linux');
      const sorted = [...candidates].sort((a, b) => a.sortText.localeCompare(b.sortText));
      assert.deepStrictEqual(
        sorted.map((c) => c.label),
        ['row', 'shared/header']
      );
    });

    // Two directories can offer the same bare name, and the widget would show it twice with no way
    // to tell them apart.
    test('should keep only the first path for a repeated label', () => {
      const candidates = partialCompletionCandidates([`${HERE}/_row.slim`, `${HERE}/_row.erb`], VIEWS, HERE, 'linux');
      assert.strictEqual(candidates.length, 1);
      assert.strictEqual(candidates[0]?.path, `${HERE}/_row.slim`);
    });

    test('should drop a path outside the base', () => {
      assert.deepStrictEqual(partialCompletionCandidates(['/elsewhere/_row.slim'], VIEWS, HERE, 'linux'), []);
    });

    test('should compare directories in the win32 dialect on win32', () => {
      const candidates = partialCompletionCandidates(
        ['C:\\repo\\app\\views\\users\\_row.slim'],
        'C:\\repo\\app\\views',
        'C:\\repo\\app\\views\\users',
        'win32'
      );
      assert.deepStrictEqual(
        candidates.map((c) => c.label),
        ['row']
      );
    });

    test('should keep the path it came from so the caller can map back to a uri', () => {
      const candidates = partialCompletionCandidates([`${VIEWS}/shared/_header.slim`], VIEWS, HERE, 'linux');
      assert.strictEqual(candidates[0]?.path, `${VIEWS}/shared/_header.slim`);
    });
  });
});

import * as assert from 'node:assert';
import { partialReferenceAt } from '../../pure/renderPartial';
import { FAST_ENOUGH_MS, fastestOf } from '../support/timing';

/** Fixtures carry a `|` where the cursor sits, so they read as Slim rather than as offsets. */
function cursor(marked: string): { line: string; character: number } {
  const character = marked.indexOf('|');
  assert.ok(character !== -1, `${JSON.stringify(marked)} has no cursor marker`);
  return { line: marked.slice(0, character) + marked.slice(character + 1), character };
}

function nameAt(marked: string): string | null {
  const { line, character } = cursor(marked);
  const reference = partialReferenceAt(line, character);
  return reference === null ? null : reference.name;
}

/** What the line becomes once a completion item replaces the literal, which is what the range is for. */
function replaced(marked: string, insertion: string): string | null {
  const { line, character } = cursor(marked);
  const reference = partialReferenceAt(line, character);
  return reference === null ? null : line.slice(0, reference.start) + insertion + line.slice(reference.end);
}

suite('pure/renderPartial Test Suite', () => {
  suite('render calls that carry a partial name', () => {
    test('should take a single-quoted positional argument', () => {
      assert.strictEqual(nameAt("= render 'shared/foo|'"), 'shared/foo');
      assert.strictEqual(nameAt("= render 'sha|red/foo'"), 'shared/foo');
    });

    test('should take a double-quoted positional argument', () => {
      assert.strictEqual(nameAt('= render "shared/foo|"'), 'shared/foo');
    });

    test('should take a parenthesised argument', () => {
      assert.strictEqual(nameAt("= render('shared/foo|')"), 'shared/foo');
      assert.strictEqual(nameAt("p= render( 'x|' )"), 'x');
    });

    test('should take the partial keyword', () => {
      assert.strictEqual(nameAt("= render partial: 'shared/foo|'"), 'shared/foo');
      assert.strictEqual(nameAt("= render(partial: 'x|')"), 'x');
    });

    test('should take the layout keyword', () => {
      assert.strictEqual(nameAt("= render layout: 'l|' do"), 'l');
    });

    // Rails underscores spacer_template: exactly like partial: when rendering a collection.
    test('should take the spacer_template keyword', () => {
      assert.strictEqual(nameAt("= render partial: 'x', collection: @posts, spacer_template: 'divider|'"), 'divider');
    });

    // The marker guard reuses computeCompletionWord, so the inline tag chain works here too.
    test('should take a render call on an inline tag chain', () => {
      assert.strictEqual(nameAt("li: div= render 'x|'"), 'x');
    });

    test('should take a control code marker and a tag marker', () => {
      assert.strictEqual(nameAt("- render 'x|'"), 'x');
      assert.strictEqual(nameAt("p= render 'x|'"), 'x');
      assert.strictEqual(nameAt('td.a{b="1"}= render \'x|\''), 'x');
    });

    // Slim's whitespace modifiers ride on the marker. The Rails snippets leave such a marker alone,
    // because their body would overwrite it; a partial name sits past it and overwrites nothing.
    test('should take a marker that carries a whitespace modifier', () => {
      assert.strictEqual(nameAt("=> render 'x|'"), 'x');
      assert.strictEqual(nameAt("=< render 'x|'"), 'x');
      assert.strictEqual(nameAt("=<> render 'x|'"), 'x');
      assert.strictEqual(nameAt("==' render 'x|'"), 'x');
      assert.strictEqual(nameAt("td => render 'x|'"), 'x');
    });

    test('should not mistake a text marker or a tag modifier for a script marker', () => {
      assert.strictEqual(nameAt("' render 'x|'"), null);
      assert.strictEqual(nameAt("p> render 'x|'"), null);
    });

    test('should take an empty literal, which is where completion starts', () => {
      assert.strictEqual(nameAt("= render '|'"), '');
      assert.strictEqual(nameAt('= render "|"'), '');
    });

    // The literal is unterminated for as long as the user is typing the name.
    test('should take an unterminated literal, which is what typing a name produces', () => {
      assert.strictEqual(nameAt("= render 'sha|"), 'sha');
      assert.strictEqual(replaced("= render 'sha|", 'shared/foo'), "= render 'shared/foo");
    });

    // With the closing quote missing - autoClosingQuotes off, or the quote deleted - the literal runs
    // to the end of the line, and a range that followed it there would make accepting a completion
    // delete the rest of the call.
    test('should end an unterminated literal where the name ends, not where the line does', () => {
      assert.strictEqual(nameAt("= render 'sha|, locals: { post: @post }"), 'sha');
      assert.strictEqual(replaced("= render 'sha|, locals: { post: @post }", 'shared/foo'), "= render 'shared/foo, locals: { post: @post }");
      assert.strictEqual(replaced("= render 'shared/fo|o) if x", 'shared/foo'), "= render 'shared/foo) if x");
      assert.strictEqual(nameAt("= render 'sha, lo|cals: { a: 1 }"), null);
    });

    // A directory may carry a dash or a dot even though a partial's own name may not.
    test('should keep a dash or a dot inside an unterminated name', () => {
      assert.strictEqual(nameAt("= render 'admin/my-dir/na|"), 'admin/my-dir/na');
      assert.strictEqual(nameAt("= render 'foo.html|"), 'foo.html');
    });

    // A later argument written with the same quote closes the literal as far as a scanner can tell,
    // which is the usual shape under RuboCop's single quotes. A partial path holds no comma, so one
    // inside the literal says the closing quote belongs to something else.
    test('should end a name that a later literal appears to close', () => {
      assert.strictEqual(nameAt("= render 'sha|, title: 'x'"), 'sha');
      assert.strictEqual(replaced("= render 'sha|, title: 'x'", 'shared/foo'), "= render 'shared/foo, title: 'x'");
      assert.strictEqual(nameAt("= render partial: 'sha|, locals: { a: 'b' }"), 'sha');
      assert.strictEqual(nameAt("= render 'sha, title: 'x|'"), null);
      // The name ends where the call goes on, not at the comma, and the quote that seemed to close
      // it no longer bounds it: a cursor between the two is outside the name.
      assert.strictEqual(nameAt("= render 'sha| , title: 'x'"), 'sha');
      assert.strictEqual(nameAt("= render 'sha, ti|tle: 'x'"), null);
    });

    // The comma that gives a later argument away is one in the path itself. One inside `#{...}` is
    // Ruby's, in a literal that is complete: cutting the name there resumes the scan inside the
    // interpolation, takes the real closing quote for an opening one, and loses every argument after.
    test('should not take a comma inside an interpolation for the end of the name', () => {
      assert.strictEqual(nameAt(`= render "cards/#{card.kind.tr('-', '_')}", layout: 'bo|x'`), 'box');
      assert.strictEqual(nameAt(`= render partial: "cards/#{kind.tr('-', '_')}", spacer_template: 'cards/spa|cer'`), 'cards/spacer');
      assert.strictEqual(nameAt(`= render "cards/|#{card.kind.tr('-', '_')}"`), "cards/#{card.kind.tr('-', '_')}");
      assert.strictEqual(replaced(`= render "cards/|#{card.kind.tr('-', '_')}"`, 'cards/item'), '= render "cards/item"');
      assert.strictEqual(nameAt('= render "sha|, title: "x"'), 'sha');
    });

    // Single quotes do not interpolate, so `#{` there is a mistake - but it is one people make, the
    // line is complete, and cutting the name inside it writes `'shared/foo"-", "_")}'` on accepting.
    test('should step over an interpolation in single quotes as well', () => {
      assert.strictEqual(nameAt(`= render 'cards/#{kind.tr("-", "_")}', layout: 'bo|x'`), 'box');
      assert.strictEqual(replaced(`= render 'cards/|#{kind.tr("-", "_")}', layout: 'box'`, 'shared/foo'), "= render 'shared/foo', layout: 'box'");
      // The first line resolves even with the name cut inside it: what is left of the name reads as
      // a value left open, which ends just in front of `layout:`. This one has no such luck.
      assert.strictEqual(nameAt(`= render 'cards/#{a(1, "x")}', layout: 'bo|x'`), 'box');
      // What every `#{` is while it is typed: a `#` alone, and part of the name.
      assert.strictEqual(nameAt("= render 'sha#|, title: 'x'"), 'sha#');
    });

    // An interpolation is stepped over, not stopped at: the comma behind `#{kind}` is the call's, and
    // a name that has lost its quote is closed by the next argument's just the same. Stopping at the
    // `#{` leaves the name running to that quote, and accepting a completion takes `, title: ` along.
    test('should still find the comma behind an interpolation', () => {
      assert.strictEqual(nameAt('= render "car|ds/#{kind}, title: "x"'), 'cards/#{kind}');
      assert.strictEqual(replaced('= render "car|ds/#{kind}, title: "x"', 'shared/foo'), '= render "shared/foo, title: "x"');
      assert.strictEqual(nameAt("= render partial: 'cards/#{kind}|, collection: @cards, spacer_template: 'spacer'"), 'cards/#{kind}');
      assert.strictEqual(nameAt("= render 'cards/#{kind}, ti|tle: 'x'"), null);
      // A nested literal may hold the brace and the comma both; neither is the path's. The cursor
      // sits in the name: a later argument resolves even when the name is cut at the nested brace.
      assert.strictEqual(nameAt(`= render "cards/|#{h['}', ',']}", layout: 'box'`), "cards/#{h['}', ',']}");
      // `#{` with nothing to close it is text, and the comma behind it counts.
      assert.strictEqual(nameAt("= render 'sha#{|, title: 'x'"), 'sha#{');
    });

    // The `}`, the quotes and the spaces of an interpolation are not where a name left open ends.
    test('should keep an interpolation whole in a name left open', () => {
      assert.strictEqual(nameAt(`= render "cards/#{ki|nd}, title: 'x'`), 'cards/#{kind}');
      assert.strictEqual(replaced(`= render "cards/#{ki|nd}, title: 'x'`, 'shared/foo'), `= render "shared/foo, title: 'x'`);
      assert.strictEqual(nameAt(`= render "cards/#{a ? b : c}|, title: 'x'`), 'cards/#{a ? b : c}');
      assert.strictEqual(nameAt(`= render "cards/#{kind.tr('-', '_')}|, title: 'x'`), "cards/#{kind.tr('-', '_')}");
    });

    // Each interpolation of a name is stepped over, not the first alone, and one left open ahead of
    // it changes nothing about the next: `#{ki` is what `#{kind}` is while it is typed in front of
    // a `/#{size}` that is already there.
    test('should step over every interpolation of a name', () => {
      assert.strictEqual(nameAt(`= render "#{dir}/#{kind.tr('-', '_')}|", layout: 'box'`), "#{dir}/#{kind.tr('-', '_')}");
      assert.strictEqual(nameAt(`= render "#{dir}/#{kind.tr('-', '_')}", layout: 'bo|x'`), 'box');
      assert.strictEqual(replaced('= render "cards/#{ki|/#{size}", title: "x"', 'shared/foo'), '= render "shared/foo", title: "x"');
      assert.strictEqual(replaced(`= render "#{ki|/#{kind.tr('-', '_')}", layout: 'box'`, 'shared/foo'), `= render "shared/foo", layout: 'box'`);
      assert.strictEqual(nameAt("= render '#{#{|a}, title: 'x'"), '#{#{a}');
    });

    // The brace that ends the line closes the hash, not the interpolation. Taken for the
    // interpolation's, it makes the name the rest of the line and the completion deletes the locals.
    test('should not close an interpolation with a brace that closes something else', () => {
      assert.strictEqual(nameAt('= render "cards/#{ki|, locals: { a: 1 }'), 'cards/#{ki');
      assert.strictEqual(replaced('= render "cards/#{ki|, locals: { a: 1 }', 'shared/foo'), '= render "shared/foo, locals: { a: 1 }');
      assert.strictEqual(replaced("= render 'cards/#{ki|, locals: { a: 1 }", 'shared/foo'), "= render 'shared/foo, locals: { a: 1 }");
    });

    // A brace left over further along does close it, as it does for Ruby, and the name runs that
    // far. Telling the two apart would take reading the Ruby inside the interpolation.
    test('should let a stray brace close an interpolation left open', () => {
      assert.strictEqual(nameAt('= render "cards/#{ki|, title: "x" }'), 'cards/#{ki, title: "x" }');
      // Not one behind the quote that closes the literal: an interpolation ends inside its own.
      assert.strictEqual(nameAt("= render 'cards/#{ki|, title: 'x' }"), 'cards/#{ki');
      // And a `#` with no brace of its own opens nothing for the hash behind it to close.
      assert.strictEqual(nameAt("= render 'posts/#|, locals: { a: 1 }"), 'posts/#');
    });

    // The comma rule is for a partial name only. Applied to any other value it cuts `'a, partial: '`
    // off at the comma, reads the words after it as a keyword, and takes the quote that closes the
    // value for the one that opens a partial name.
    test('should leave a comma alone in a literal that is not a partial name', () => {
      assert.strictEqual(nameAt("= render 'x', title: 'a, b', layout: 'l|'"), 'l');
      assert.strictEqual(nameAt("= render 'x', title: 'a, partial: |'"), null);
      assert.strictEqual(nameAt("= render 'x', title: 'a, partial: '|"), null);
      assert.strictEqual(nameAt("= render 'x', title: 'a, layout: 'b|"), null);
    });

    // While a value is being typed its closing quote is missing, and Ruby reads it to the end of the
    // line. What follows it there is the rest of the call, as it is after an unterminated name, and
    // giving up on the line would lose a partial name that is complete.
    test('should read on past a value that is still unterminated', () => {
      assert.strictEqual(nameAt(`= render 'x', title: 'abc, layout: "l|"`), 'l');
      assert.strictEqual(nameAt(`= render 'x', title: "abc, layout: 'l|'`), 'l');
      assert.strictEqual(nameAt(`= render 'x', title: "it's, layout: 'l|'`), 'l');
    });

    // A title holds what a path does not - spaces, a bracket, an apostrophe, the word `do` - and none
    // of it is Ruby's to read. Cut at the first space or quote, the value leaves `do` to end the
    // argument list and `[` to take the rest of the line as a group.
    test('should end a value left open at its first comma and nowhere before it', () => {
      assert.strictEqual(nameAt(`= render 'x', title: 'What to do, layout: "l|"`), 'l');
      assert.strictEqual(nameAt(`= render 'x', title: 'Sign in [beta, layout: "l|"`), 'l');
      assert.strictEqual(nameAt(`= render('x', title: 'Well done :) now, layout: "l|")`), 'l');
      assert.strictEqual(nameAt(`= render 'x', title: "What's there to do, layout: 'l|'`), 'l');
      // With no comma behind it there is no next argument, and the words are the title's.
      assert.strictEqual(nameAt(`= render 'x', title: 'abc layout: "l|"`), null);
      // The first comma may be the title's own, and the words behind that one are Ruby's again.
      assert.strictEqual(nameAt(`= render 'x', title: 'Well, what to do, layout: "l|"`), null);
    });

    // One literal is unfinished at a time while typing; here two are, and the name behind them is
    // still found.
    test('should reach a name past two literals cut short', () => {
      assert.strictEqual(nameAt(`= render 'sha, title: "abc, layout: 'l|'`), 'l');
    });

    // A literal cut short puts the scan back inside text its search has been through, where an
    // escaped quote opens another literal. What cut it makes no difference. The value left open is
    // cut at its comma, and so is each `\'b` behind it: one and seven. The name holding a comma is
    // closed by a quote far behind it, and so is each `\'b` it leaves but the last: eight of eight.
    // Eight still resolve - far more than a line being typed holds - and nine do not.
    test('should give up on a call that keeps cutting literals short', () => {
      const open = (count: number): string => `= render 'x', title: 'a${", x: \\'b".repeat(count)}, layout: "l|"`;
      const commas = (count: number): string => `= render partial: 'a${", partial: \\'b".repeat(count)}', layout: "l|"`;
      assert.strictEqual(nameAt(open(7)), 'l');
      assert.strictEqual(nameAt(open(8)), null);
      assert.strictEqual(nameAt(commas(8)), 'l');
      assert.strictEqual(nameAt(commas(9)), null);
    });

    // Past the limit the line is not one being typed, and a name cut short in it is as much a guess
    // under the cursor as anywhere else. A name that runs to the end of the line is not cut at all.
    test('should refuse a ninth literal cut short even under the cursor', () => {
      const eight = `= render 'x', title: 'a${", x: \\'b".repeat(7)}, layout: `;
      assert.strictEqual(nameAt(`${eight}"l|, more: 1`), null);
      assert.strictEqual(nameAt(`${eight}"l|`), 'l');
    });

    // Both ends count as inside so that re-editing an existing name resolves and completes.
    test('should cover both ends of the literal', () => {
      assert.strictEqual(nameAt("= render '|x'"), 'x');
      assert.strictEqual(nameAt("= render 'x|'"), 'x');
    });

    test('should keep the rest of the line when the literal is replaced', () => {
      assert.strictEqual(replaced("= render 'sha|', locals: { a: 1 }", 'shared/foo'), "= render 'shared/foo', locals: { a: 1 }");
      assert.strictEqual(replaced("= render('x|')", 'y'), "= render('y')");
    });

    // `#{}` may hold the literal's own quote character; the literal still runs to its real
    // terminator, not to the interpolation's inner quote.
    test('should span an interpolation holding the same quote', () => {
      assert.strictEqual(nameAt('= render "card|#{x["k"]}"'), 'card#{x["k"]}');
    });
  });

  suite('literals that are not partial names', () => {
    // Taking this one would offer view names inside every locals hash.
    test('should not take a value inside a nested hash', () => {
      assert.strictEqual(nameAt("= render 'x', locals: { a: 'b|' }"), null);
      assert.strictEqual(nameAt("= render partial: 'x', locals: { a: { b: 'c|' } }"), null);
    });

    test('should not take the value of a keyword that is not partial or layout', () => {
      assert.strictEqual(nameAt("= render collection: 'x|'"), null);
      assert.strictEqual(nameAt("= render object: 'x|'"), null);
      assert.strictEqual(nameAt("= render template: 'x|'"), null);
    });

    test('should take the partial keyword even when other keywords precede it', () => {
      assert.strictEqual(nameAt("= render collection: @posts, partial: 'x|'"), 'x');
    });

    // Only the first positional argument is the partial name.
    test('should not take a later positional argument', () => {
      assert.strictEqual(nameAt("= render 'x', 'y|'"), null);
    });

    test('should not take anything past a block opener', () => {
      assert.strictEqual(nameAt("= render layout: 'l' do |x| = f 'y|'"), null);
    });

    // The argument list ends at the closing parenthesis, so a later call on the line is not ours.
    test('should not take anything past a closing parenthesis', () => {
      assert.strictEqual(nameAt("= render('x') + f('y|')"), null);
    });

    // A hash the user has not finished typing runs to the end of the line and swallows the rest.
    test('should not take a value inside an unterminated hash', () => {
      assert.strictEqual(nameAt("= render 'x', locals: { a: 'b|'"), null);
    });

    test('should return null outside any literal', () => {
      assert.strictEqual(nameAt("= render 'x'|"), null);
      assert.strictEqual(nameAt("= render| 'x'"), null);
      assert.strictEqual(nameAt("|= render 'x'"), null);
    });

    // An escaped quote does not end the literal, so the cursor is still inside it.
    test('should not let an escaped quote end the literal', () => {
      assert.strictEqual(nameAt("= render 'it\\'s x|'"), "it\\'s x");
    });
  });

  suite('positions where render is not a Slim script call', () => {
    // These are the five cases computeCompletionWord decides; renderPartial reuses it as the guard.
    test('should reject prose that merely contains the word render', () => {
      assert.strictEqual(nameAt("p Please render 'x|'"), null);
      assert.strictEqual(nameAt("  Some prose about render 'x|'"), null);
    });

    // In Slim a bare word before the marker is a tag - `x = render` outputs into <x> - so this
    // position takes the completion. Only prose before the marker still rejects it.
    test('should take a tag-with-output line as a script call', () => {
      assert.strictEqual(nameAt("  x = render 'y|'"), 'y');
    });

    test('should reject prose before the marker', () => {
      assert.strictEqual(nameAt("  some words = render 'y|'"), null);
    });

    // A line with no script marker renders as literal text, so nothing on it is a call.
    test('should reject a line with no script marker', () => {
      assert.strictEqual(nameAt("render 'x|'"), null);
      assert.strictEqual(nameAt("  render 'x|'"), null);
    });

    test('should reject render as part of a longer identifier', () => {
      assert.strictEqual(nameAt("= x.render 'y|'"), null);
      assert.strictEqual(nameAt("= _render 'y|'"), null);
      assert.strictEqual(nameAt("= renders 'y|'"), null);
      assert.strictEqual(nameAt("= render_async 'y|'"), null);
    });

    test('should reject a different helper', () => {
      assert.strictEqual(nameAt("= link_to 'x|'"), null);
      assert.strictEqual(nameAt("= t('.title|')"), null);
    });

    test('should reject an attribute hash', () => {
      assert.strictEqual(nameAt("div{ class: 'x|' }"), null);
      assert.strictEqual(nameAt('a(href="x|")'), null);
    });
  });

  // A quadratic scan here would freeze the extension host on a line holding a data URI, once per
  // keystroke. The repeated-token line is the input that punishes slicing the prefix per candidate:
  // without the candidate limit its 5000 `render` tokens would each slice the whole prefix.
  //
  // The line of keywords is the one that punishes looking for a comma past the literal being read:
  // every `partial:` value is a name, and none of them holds a comma to stop the search early. It is
  // a megabyte because that search is a native indexOf, which c8 does not slow down while it slows
  // the scan around it: at a quarter of the size the search costs 127 ms there, inside the budget
  // c8 is given, against 26 ms without it. At this size it is 1771 ms against 103.
  test('should stay fast on a very long line', () => {
    const repeated = `= render ${'render '.repeat(5000)}'x'`;
    const dataUri = `img src="data:image/png;base64,${'A'.repeat(100000)}" = render 'x'`;
    const keywords = `= render ${"partial: 'x' ".repeat(80000)}`;
    const elapsed = fastestOf(() => {
      partialReferenceAt(dataUri, 100060);
      partialReferenceAt(repeated, repeated.length);
      partialReferenceAt(keywords, keywords.length);
    });
    assert.ok(elapsed < FAST_ENOUGH_MS, `took ${elapsed}ms`);
  });

  // A literal cut short resumes the scan inside text its search has been through, and there each
  // escaped quote opens another whose search is the rest of the line: a name left open, a value left
  // open, a name closed by the last quote of the line and cut at its comma. Each line is held to the
  // budget on its own: under c8 these scans run several times slower, and one shared budget would
  // leave no guard the room a loaded machine needs.
  test('should stay fast on a line of literals that are cut short', () => {
    const lines = [
      `= render partial: '${"\\' partial: ".repeat(5000)}`,
      `= render 'x', title: 'a${", x: \\'b".repeat(5000)}`,
      `= render partial: 'a${", partial: \\'b".repeat(5000)}'`
    ];
    for (const line of lines) {
      const elapsed = fastestOf(() => {
        partialReferenceAt(line, line.length);
      });
      assert.ok(elapsed < FAST_ENOUGH_MS, `${line.slice(0, 40)} took ${elapsed}ms`);
    }
  });

  // An interpolation is searched for its closing brace, and one that has none is searched to the end
  // of its literal: once per `#{` unless the first failure ends the looking, in a name closed by a
  // later quote and in one that nothing closes.
  test('should stay fast on a line of interpolations that never close', () => {
    const lines = [`= render partial: '${'#{'.repeat(20000)}, x'`, `= render '${'#{'.repeat(20000)}`];
    for (const line of lines) {
      const elapsed = fastestOf(() => {
        partialReferenceAt(line, line.length);
      });
      assert.ok(elapsed < FAST_ENOUGH_MS, `${line.slice(0, 40)} took ${elapsed}ms`);
    }
  });
});

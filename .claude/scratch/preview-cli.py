ROOT = r"C:\Users\akrizu\atelier\apps\web\src"

def patch(path, pairs):
    full = ROOT + "\\" + path
    s = open(full, encoding="utf-8").read()
    for old, new in pairs:
        assert old in s, "missing in " + path + ":\n" + old[:160]
        s = s.replace(old, new, 1)
    open(full, "w", encoding="utf-8", newline="\n").write(s)

patch("views\cli\CliConsolePane.tsx", [
    (
        """ * a session that has touched nothing shows nothing.
 */
export function CliConsolePane() {""",
        """ * a session that has touched nothing shows nothing.
 *
 * `compact` is the Page preview sidebar: the same terminal in a narrow
 * column beside the preview, where the rail has no room and the preview
 * itself is what the user is watching for changes.
 */
export function CliConsolePane(props: { compact?: boolean } = {}) {
  const compact = props.compact === true;""",
    ),
    (
        """      <ChangesRail
        vm={{ ...changes, loading: changes.loading || cliLoading }}
        status={null}
      />
    </div>""",
        """      {!compact && (
        <ChangesRail
          vm={{ ...changes, loading: changes.loading || cliLoading }}
          status={null}
        />
      )}
    </div>""",
    ),
])

patch("views\shell\AppShell.tsx", [
    (
        """        <div className="min-h-0 flex-1">
          <ChatPanel compact shellError={sessions.error} />
        </div>""",
        """        {/* The picked session decides the box here too: a CLI row is
            its terminal, any other row the chat. */}
        <div className="min-h-0 flex-1">
          {boundCliLive ? (
            <CliConsolePane compact />
          ) : (
            <ChatPanel compact shellError={sessions.error} />
          )}
        </div>""",
    ),
])
print("ok")

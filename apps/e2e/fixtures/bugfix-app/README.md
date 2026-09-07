# bugfix-app

A deliberately broken zero-dependency Node project. `npm test` fails until the
off-by-one in `src/math.js` is fixed. Used by the e2e suites as a repository
the agent clones and works in — it needs no `npm install`, so it runs inside a
sandbox with nothing but Node.

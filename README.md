# studywise-server

The course marketplace for [Studywise Courses](https://github.com/SnakeLuck360GT/studywise-courses). People publish weeks they've generated in the app (topics, notes, questions, flashcards, and the slides and transcripts behind them), and others browse them and add them to their own courses without spending tokens generating them again.

- **Courses belong to nobody.** Everyone's weeks for a course with the same name (ignoring case and spacing) go in the same course. Each week belongs to whoever published it: only they (or the site owner) can take it down, and publishing your own week with the same name again replaces yours, not anyone else's.
- **Browse** courses in the app, open one to see its weeks, and expand a week to see its topics and sections. Each week shows which model and effort planned it and wrote its topics.
- **Add a week** to one of your courses, or to a new one.
- **Publish** a week from its ⋯ menu in the app. Publishing the same week again replaces it.
- **"Someone has already made this"**: before the app plans a new week, it sends the server a fingerprint of the week's material (a MinHash of its text and a sha256 of each file, never the files themselves). If a published week was made from the same slides, the app shows it and asks whether to use it instead.

## Accounts and keys

People make an account on the site, then make an API key on their account page (`/account`). In Studywise they open **Settings → Marketplace** and paste the site's address and the key. Every API call from the app sends the key. Keys are stored as hashes and shown once. Each person can have up to 10, and deleting one stops it working straight away.

## Only Studywise weeks

Uploads are checked before anything is stored (`lib/studyweek.js`):

- It has to be a zip holding `week.json` from Studywise Courses (`app: "studywise-courses"`, `kind: "week"`), with at least one written topic.
- The zip may hold `week.json` and the files `week.json` lists, and nothing else. No extra entries and no paths with `..`.
- Every file must be a kind the app takes (PDF, Word, PowerPoint, text, Markdown, subtitles, web pages, RTF, CSV, PNG/JPG/WebP/GIF), and its bytes must match that kind: a `.pdf` has to start like a PDF, a `.txt` has to be text, and so on.
- Size limits: 300 MB per upload (`MAX_UPLOAD_MB`), and the unpacked size is checked before anything is unpacked.

Weeks are only ever downloaded by the app, as attachments, so an uploaded HTML page is never shown in a browser.

## Self-hosting with Docker

```sh
git clone https://github.com/SnakeLuck360GT/studywise-server.git
cd studywise-server
PUBLIC_URL=https://courses.example.com docker compose up -d
docker compose exec studywise-server node manage.js add-user yourname --owner
```

That prints your password. The server listens on `127.0.0.1:3005`. Put something that does HTTPS in front of it (Caddy, nginx, Traefik, a Cloudflare tunnel). With Caddy, this is all it takes:

```
courses.example.com {
	request_body {
		max_size 310MB
	}
	reverse_proxy 127.0.0.1:3005
}
```

Everything it keeps (accounts, keys, published weeks) is in the `studywise-data` volume, mounted at `/data`.

| Setting | Default | |
|---|---|---|
| `PUBLIC_URL` | | The address people open. With `https://`, logins use secure cookies. |
| `MAX_UPLOAD_MB` | 300 | Largest week that can be published. |
| `UPLOADS_PER_DAY` | 60 | Weeks one person can publish in a day. |
| `SIGNUPS_PER_DAY` | 5 | New accounts from one address in a day. |
| `TRUST_PROXY` | 1 | Read the visitor's address from `X-Forwarded-For`. Set to `0` if nothing is in front of the server, so it can't be faked. |

## On an Ubuntu server without Docker

`deploy/setup.sh` installs Node and Caddy, runs the server with systemd on port 3005, and gets the HTTPS certificate. It can share a server with other sites: it writes `/etc/caddy/sites/studywise-server.caddy`, and `/etc/caddy/Caddyfile` imports every file there.

```sh
rsync -az --delete --exclude node_modules --exclude data ./ ubuntu@SERVER:studywise-server/
ssh ubuntu@SERVER 'cd studywise-server && sudo DOMAIN=courses.example.com ADMIN=yourname bash deploy/setup.sh'
```

To update later, rsync again and rerun the script without `ADMIN`.

- Logs: `journalctl -u studywise-server -f`
- Settings: `/etc/studywise-server.env`
- Data: `/var/lib/studywise-server`

## Managing it

From SSH (`sudo studywise-server-admin …`) or Docker (`docker compose exec studywise-server node manage.js …`):

- `add-user <name> [--owner]`: make an account and print its password
- `reset-password <name>`: print a new password and log them out everywhere
- `delete-user <name>`: remove an account, its keys and everything it published
- `list`: accounts
- `weeks`: every published week
- `delete-week <id>`: take a week down

The owner's account page also lists every published week, with a button to take each one down.

## Running locally

```sh
npm install
npm test
DATA_DIR=./data node server.js          # http://127.0.0.1:3005
DATA_DIR=./data node manage.js add-user me --owner
```

In Studywise, `http://localhost:3005` works as the marketplace address. Anywhere else it has to be `https://`.

## The API

Everything except `/api/stats`, `/api/signup` and `/api/login` needs a session (the site) or `Authorization: Bearer swm_…` (the app).

| | |
|---|---|
| `GET /api/courses?q=&sort=recent\|popular` | Courses, with their weeks counted and the models used |
| `GET /api/courses/:id` | A course and its weeks: topics, sections, levels, models, files |
| `POST /api/weeks[?replace=id]` | Publish a `.studyweek` (body `application/zip`) |
| `GET /api/weeks/:id/file` | Download one |
| `DELETE /api/weeks/:id` | Take one down (its author or the owner) |
| `GET /api/mine` | Weeks you've published |
| `POST /api/similar` | `{v, sig, hashes}`: published weeks made from the same material |
| `GET /api/app/me` | Whose key this is |

Keys (`/api/keys`) and passwords can only be changed from the site.

# Server - CV Management System

Backend for the CV Management System course project.

For the full product overview, feature list, and live links, see the root README: `../README.md`.

## Stack

- Node.js
- Express.js
- Prisma ORM
- PostgreSQL / Neon
- Passport.js

## Local Setup

```bash
cd server
npm install
cp .env.example .env
npx prisma migrate deploy
npx prisma generate
npm run dev
```

Default local URL: `http://localhost:4000`

## Environment Variables

Example values only. Do not commit real secrets.

```env
DATABASE_URL=
DIRECT_URL=
PORT=4000
CLIENT_ORIGIN=http://localhost:5173
CLIENT_URL=http://localhost:5173
OAUTH_LOGIN_TOKEN_SECRET=
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_CALLBACK_URL=http://localhost:4000/api/auth/oauth/google/callback
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
GITHUB_CALLBACK_URL=http://localhost:4000/api/auth/oauth/github/callback
```

## Run Commands

```bash
npm run dev
npm start
```

## Architecture Note

CV data is generated dynamically.

The `Cv` entity stores only metadata such as user, position, status, version, and timestamps. Rendered CV content is assembled from:

- position templates
- reusable attributes
- candidate profile attribute values
- candidate projects
- status and likes metadata

This keeps the implementation aligned with the relational course requirement and avoids JSON snapshot storage.

## API Summary

### Auth

- `POST /api/auth/dev-login`
- `GET /api/auth/oauth/google`
- `GET /api/auth/oauth/github`
- `POST /api/auth/oauth/complete`

### Public

- `GET /api/public/positions`
- `GET /api/public/stats`
- `GET /api/public/search`

### Attributes

- `GET /api/attributes`
- `POST /api/attributes`
- `PUT /api/attributes/:id`
- `DELETE /api/attributes`

### Positions

- `GET /api/positions`
- `POST /api/positions`
- `PUT /api/positions/:id`
- `DELETE /api/positions`
- `POST /api/positions/:id/duplicate`
- `GET /api/positions/:positionId/cvs`
- `GET /api/positions/:positionId/discussions`
- `POST /api/positions/:positionId/discussions`

### Profile

- `GET /api/profile-attributes`
- `PUT /api/profile-attributes/:attributeId`
- `DELETE /api/profile-attributes`

### Projects

- `GET /api/projects/my`
- `POST /api/projects`
- `PUT /api/projects/:id`
- `DELETE /api/projects`

### CVs

- `GET /api/cvs/my`
- `POST /api/cvs`
- `GET /api/cvs/:id`
- `PATCH /api/cvs/:id/publish`
- `DELETE /api/cvs`
- `POST /api/cvs/:id/like`
- `DELETE /api/cvs/:id/like`

### Dashboard

- `GET /api/dashboard/stats`

### Search

- `GET /api/search`

### Admin

- `GET /api/admin/users`
- `PATCH /api/admin/users/:id/role`
- `PATCH /api/admin/users/:id/status`

## Demo Accounts

- Candidate: `candidate@test.com`
- Recruiter: `recruiter@test.com`
- Admin: `admin@test.com`

Demo login is available for testing. OAuth login through Google and GitHub is also supported.

## Known Limitations

- Demo login and OAuth are intended for course-project testing; classic email/password registration is not included.
- Discussion refresh is polling-based.
- Image handling in profile values is URL-based in the current MVP.

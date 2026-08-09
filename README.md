# StudyFlow research deployment

StudyFlow preserves the pastel student planner UI while adding a Supabase-backed participant system, task/session logging, daily research summaries, baseline entry, and a separate authenticated researcher dashboard.

## What is collected

Only an anonymous participant code, task data, completion activity, Pomodoro session timings, and daily totals are stored. The participant code is not a password: each participant signs in with a researcher-issued private PIN. Do not put names or contact details in the app. Replace the in-app privacy message with school-approved consent language before use.

## 1. Create the Supabase project

1. Create a Supabase project and open its SQL Editor.
2. Run [`supabase/schema.sql`](./supabase/schema.sql) once. Change `baseline_start` in `study_settings` to the first actual baseline date before enrolling participants.
3. In Authentication, create one email/password user per participant. Use an internal anonymous email such as `p001@participant.studyflow.invalid`, a strong researcher-issued PIN/password, and disable email confirmation if your school process does not use email. Then add the matching row to `participants` using the user's Auth UUID and code (`P001`).
4. Create the researcher user in Authentication, then run the commented `profiles` command at the bottom of the SQL file with that Auth UUID. This role is enforced by Row Level Security, not by the URL.
5. In Project Settings → API, copy the Project URL and anon/publishable key into a local `.env` created from `.env.example`. Never put a service-role key in this file or frontend.

## 2. Run locally

```bash
npm install
copy .env.example .env
# fill in the two VITE_SUPABASE_* values
npm run dev
```

Open the local URL shown by Vite. Participants sign in at `/`; authorized researchers sign in at `/researcher.html`.

## 3. Deploy

1. Upload this `outputs` folder to a private GitHub repository, or deploy it directly with Vercel.
2. Create a Vercel project. Framework preset: Vite. Build command: `npm run build`; output directory: `dist`.
3. Add `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` to Vercel Environment Variables, then deploy.
4. In Supabase Authentication URL Configuration, add the deployed HTTPS address to allowed redirect URLs if you later enable password recovery or magic links.

The anon key is intentionally public; RLS prevents it from reading other users’ records. The service-role key remains server-only and is not used by this project.

## Research data workflow

- Task create/completion and completed focus sessions are stored centrally. Database triggers update `daily_productivity` so researchers do not compile totals manually.
- During the configured 7-day baseline, the More tab offers a one-number baseline entry. The database RPC only accepts it during `BASELINE`.
- During intervention, task completion is explicit: finishing a Pomodoro does not complete the task.
- The researcher dashboard calculates baseline/intervention averages, participant differences, filters daily records, and exports the required summary/raw CSVs.

## Testing checklist

Create `TEST-001` and `TEST-002` with different private PINs. Verify each account only sees its own task list, then use the researcher account to verify both appear in aggregate/export data. Test a task creation, explicit completion, a completed session, and a baseline entry. Delete test rows and Auth users before enrolling real participants.

## Important operations

- Researchers set the study period only in `study_settings`; participants have no write policy for it.
- There is no client-side “reset data” button because irreversible centralized deletion must be an authorized researcher/database operation. Take an encrypted backup first, then delete via a restricted Supabase admin workflow.
- If connectivity fails during a write, the app shows a retry notice instead of silently treating the data as saved. For use in unreliable internet areas, add a server-side/background-sync queue before data collection.

This app collects and organizes research data. It does not establish that Pomodoro use improves productivity; analysis and interpretation remain with the researchers and adviser.

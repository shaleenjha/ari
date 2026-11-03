# Google Sheet template ("Outbound HQ")

Column headers only. Make one Google Sheet with these tabs, in this order, with row 1 exactly as below. The sync finds columns by header name, so order inside a tab matters only for the People tab (the worker prompt names its letters). Columns the sync wants but you don't have yet get appended automatically on the first run (`dm2_text`, `dm3_text`, `play`, `context`, account `stage` columns).

## People
```
id	company	owner	name	title	linkedin_url	role	route	connect_day	stage	dm	connect_sent	accepted	dm1_sent	dm2_due	dm2_sent	dm3_due	dm3_sent	replied	meeting	next_action	notes	withdrawn	source	review	research	snooze_until	skipped	why	dm2_text	dm3_text	play	context
```
Letters the worker prompt uses: A id, B company, C owner, D name, E title, F linkedin_url, G role, H route, I connect_day, J stage, K dm, L connect_sent, M accepted, N dm1_sent, O dm2_due, P dm2_sent, Q dm3_due, R dm3_sent, S replied, T meeting, U next_action, V notes, W withdrawn, X source, Y review, Z research, AC why.

## Accounts
```
company	owner	ae	one_liner	hook	hook_date	hook_url	why_<seller>	suggested_order	status	play	meeting_status	meeting_source	meeting_date	meeting_person	meeting_ae	meeting_notes	domain	stage	stage_source	stage_reason
```

## Book
```
company	owner	tier	flag	cluster	fit	last_checked	last_signal	website
```

## Brief
```
key	value
```
Keys the app and worker use: `date`, `opener`, `focus`, `heads_up`, `gmail_last_scan`, `gmail_confirmed`, `signal_scans`.

## Queue
```
id	created	action	target	details	status	result
```

## Emails
```
id	created	to_name	to_email	company	subject	body	status
```

## Log
```
ts	person_id	event	detail
```

Dates are `yyyy-MM-dd` (IST). Event times (`connect_sent`, `accepted`, `dm1_sent`, `dm2_sent`, `dm3_sent`) are `yyyy-MM-dd HH:mm` IST; a bare date is treated as approximate.

Put the Sheet's id in the task prompts (`{SHEET_ID}`) and in `scripts/sync_sheet_supabase.py`, `li_list_ingest.py` and `profile_scan.py` (constant at the top of each; the repo shows a placeholder).

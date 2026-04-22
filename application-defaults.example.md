# Application defaults (TEMPLATE)

Copy this file to `application-defaults.md` and fill in your actual answers.
The Greenhouse / Ashby / Lever autofill bot reads `application-defaults.md` and
populates form fields automatically. Both files are gitignored except this
sanitized template.

---

## Identity

- **Legal first name:** YOUR_FIRST_NAME
- **Legal last name:** YOUR_LAST_NAME
- **Preferred name:** YOUR_PREFERRED_NAME
- **Pronouns:** they/them
- **Email (for ATS logins):** EMAIL_ALIAS_FOR_LOGINS@example.com
- **Email (canonical inbox):** YOUR_REAL_EMAIL@example.com
- **Phone:** +1 555 555 1212
- **Country code:** US (+1)
- **Current city:** YOUR_CITY, STATE, COUNTRY
- **LinkedIn:** https://linkedin.com/in/YOUR_HANDLE
- **Personal website / portfolio:** (leave blank or fill in)
- **GitHub:** (leave blank or fill in)
- **Twitter / X:** (leave blank or fill in)

## Work authorization

- **Authorized to work in the United States?** Yes / No
- **Will you require visa sponsorship now or in the future?** No / Yes
- **Are you legally authorized to work in <country>?** Yes / No

## EEOC / self-identification (US)

These are *optional* under US law. Default to "Decline to self-identify" unless
you choose to override.

- **Gender identity:** Decline to self-identify
- **Race / ethnicity:** Decline to self-identify
- **Veteran status:** I am not a protected veteran
- **Disability status:** Decline to self-identify
- **LGBTQ+:** Decline to self-identify

## Logistics

- **Available start date:** Two weeks notice from offer acceptance
- **Notice period at current role:** YOUR_NOTICE_PERIOD
- **Currently employed?** Yes / No
- **Open to relocation?** Yes / No
- **Open to remote?** Yes / No
- **Open to hybrid?** Yes / No
- **Willing to travel?** Yes / No, up to X%
- **Earliest interview availability:** Within X week(s)

## Comp expectations

- **Target base salary:** $X-$Y USD
- **Acceptable floor (with equity):** $Z USD
- **Stretch target:** $A+ USD
- **Equity expectations:** TBD by stage
- **Bonus / OTE expectations:** Standard for level
- **Currency:** USD

## How did you hear about us?

- Default: "career-ops automated job-matching pipeline"
- Alternates: "LinkedIn job alert", "Industry network referral"

## Standard short-answer Q&As

These get pasted as-is into common ATS short-answer boxes. Edit before
submitting if the question framing is unusual. Replace the placeholder text
below with your actual answers.

### "Why are you interested in this role?"
> Default to the per-role cover letter at `output/{slug}/cover-letter.md`.

### "Why are you leaving your current role?"
> YOUR_DEPARTURE_NARRATIVE

### "What's your management experience?"
> YOUR_MANAGEMENT_BACKGROUND

### "What's your availability for interviews?"
> YOUR_AVAILABILITY

### "Tell us about a relevant project."
> Defer to cover letter.

### "Anything else you'd like us to know?"
> YOUR_DIFFERENTIATOR

## Salary history (US-illegal in many states; default to declining)

> I prefer to focus on the value I'd bring to this role and the comp range we
> can align on, rather than past compensation. Happy to discuss target ranges
> directly.

## References

> Available on request.

---

## Per-ATS notes

### Greenhouse
- Resume upload: PDF from `output/cv.pdf`
- Cover letter upload: PDF from `output/{slug}/cover-letter.pdf`
- "Additional information" textarea: paste the cover letter body from `output/{slug}/cover-letter.md`

### Ashby
- Same as Greenhouse plus a "Where do you live?" field.

### Lever
- Resume upload: PDF.
- Lever often has an "Additional information" comment box -> cover letter text.

// Synthetic LinkedIn notification emails (shapes modelled on real notification layouts; all names, ids and companies are fake).
import type { RawEmail } from './parse';

export const acceptText: RawEmail = {
  id: 'msg-accept-1', from: 'LinkedIn <invitations@linkedin.com>', subject: 'Alex Doe accepted your invitation',
  date: 'Tue, 20 Oct 2026 09:14:05 +0000',
  authResults: 'mx.google.com; dkim=pass header.i=@linkedin.com header.s=d2048 header.b=abc; spf=pass',
  text: `Alex Doe\nVP Engineering at Ostrevanthe Co\nAlex Doe has accepted your invitation. Let's start a conversation.\nMessage\nhttps://www.linkedin.com/comm/in/alex-doe-4b2a19?midToken=AQ123&trk=eml-email_accept_invite_single_01-header-0-profile_glimmer&lipi=urn%3Ali%3Apage\nView Alex's profile\nUnsubscribe: https://www.linkedin.com/comm/psettings/email-unsubscribe?x=1`,
};
export const acceptHtml: RawEmail = {
  id: 'msg-accept-2', from: '"LinkedIn" <invitations@linkedin.com>', subject: 'You and Sam Roe are now connected',
  date: '2026-10-21T04:00:00Z',
  html: `<table><tr><td><a href="https://www.linkedin.com/comm/in/sam-roe?midToken=AQ&amp;trk=x"><img alt="Sam Roe"></a></td></tr>
<tr><td><p>Sam Roe</p><p>Head of Security @ Brennuvia Labs</p></td></tr><tr><td><a href="https://www.linkedin.com/comm/messaging">Message</a></td></tr></table>`,
};
export const replyMsg: RawEmail = {
  id: 'msg-reply-1', from: 'Jamie Poe via LinkedIn <messages-noreply@linkedin.com>', subject: 'Jamie Poe sent you a new message',
  date: 'Wed, 21 Oct 2026 15:30:00 +0530',
  text: `Jamie Poe\nCTO at Dravequin Systems\nThanks for reaching out, happy to chat next week. What times work?\nView message: https://www.linkedin.com/comm/messaging/thread/2-ZmFrZXRocmVhZA==?trk=eml\nhttps://www.linkedin.com/comm/in/jamie-poe-77?trk=eml\nYou are receiving notification emails from LinkedIn.`,
};
export const replyNewFrom: RawEmail = {
  id: 'msg-reply-2', from: 'LinkedIn <messaging-digest-noreply@linkedin.com>', subject: 'New message from Taylor Moe',
  date: '2026-10-22T06:00:00Z', text: 'Taylor Moe\nDirector, Platform at Nowhere Inc\nSounds interesting, send details.\n',
};
export const spoofed: RawEmail = {
  id: 'msg-spoof-1', from: 'LinkedIn <invitations@linkedin.com>', subject: 'Alex Doe accepted your invitation', date: '2026-10-22T06:00:00Z',
  authResults: 'mx.google.com; dkim=fail header.i=@linkedin-security.example.com; spf=softfail', text: 'Alex Doe\nhttps://www.linkedin.com/in/alex-doe-4b2a19',
};
export const notLinkedIn: RawEmail = { id: 'msg-other-1', from: 'News <news@example.com>', subject: 'Alex Doe accepted your invitation', date: '2026-10-22T06:00:00Z' };
export const jobAlert: RawEmail = { id: 'msg-jobs-1', from: 'LinkedIn Job Alerts <jobalerts-noreply@linkedin.com>', subject: '30 new jobs for Staff Engineer', date: '2026-10-22T06:00:00Z' };

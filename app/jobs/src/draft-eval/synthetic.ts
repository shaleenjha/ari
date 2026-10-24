// Synthetic personas and a labelled corpus for the draft eval. Every person, company and trigger here is invented
// (".test" style names); nothing is a real prospect, account or message.
export interface Persona { id: string; firstName: string; title: string; company: string; trigger: string; dataKind: string }

export const PERSONAS: Persona[] = [
  { id: 'sp-01', firstName: 'Avery', title: 'VP Engineering', company: 'Exquorra Pay', trigger: 'is hiring a data residency lead', dataKind: 'card data' },
  { id: 'sp-02', firstName: 'Blake', title: 'CISO', company: 'Saffrevane Health', trigger: 'opened an EU region', dataKind: 'patient records' },
  { id: 'sp-03', firstName: 'Casey', title: 'Head of Platform', company: 'Durnaquill', trigger: 'launched an agent API', dataKind: 'customer PII' },
  { id: 'sp-04', firstName: 'Drew', title: 'Director, Security', company: 'Fyndraquel Insure', trigger: 'posted a privacy engineer role', dataKind: 'claims data' },
  { id: 'sp-05', firstName: 'Emery', title: 'CTO', company: 'Moquadrel', trigger: 'raised a Series B', dataKind: 'user identities' },
  { id: 'sp-06', firstName: 'Finley', title: 'Staff Engineer', company: 'Pyrrhovane', trigger: 'moved to a new data warehouse', dataKind: 'bank details' },
  { id: 'sp-07', firstName: 'Gray', title: 'VP Data', company: 'Thessquorn Bio', trigger: 'started a de-identification project', dataKind: 'trial data' },
  { id: 'sp-08', firstName: 'Harper', title: 'Head of Trust', company: 'Nuvasquell', trigger: 'published a new trust page', dataKind: 'account numbers' },
];

/** Hand-labelled drafts that pin the scorer's behaviour: good = should pass the house style. */
export const LABELLED: Array<{ id: string; good: boolean; body: string; firstName?: string; company?: string }> = [
  { id: 'L01', good: true, firstName: 'Avery', company: 'Exquorra Pay', body: 'Hi Avery, saw Exquorra Pay is hiring a data residency lead. Open to a short chat on keeping card data out of app databases?' },
  { id: 'L02', good: true, firstName: 'Blake', company: 'Saffrevane Health', body: 'Hi Blake, congrats on the EU region at Saffrevane Health.\nHow are you handling patient records residency there?' },
  { id: 'L03', good: true, firstName: 'Casey', company: 'Durnaquill', body: 'Casey, the Durnaquill agent API looks sharp. Who owns how it handles customer PII?' },
  { id: 'L04', good: false, firstName: 'Drew', company: 'Fyndraquel Insure', body: 'Hi Drew, saw the privacy role at Fyndraquel Insure \u2014 worth a chat?' },                       // em dash
  { id: 'L05', good: false, firstName: 'Emery', company: 'Moquadrel', body: 'Hi Emery, congrats on the round \u2013 how are you scaling identity?' },                              // en dash
  { id: 'L06', good: false, firstName: 'Finley', company: 'Pyrrhovane', body: 'Hi Finley, I just wanted to reach out, maybe we could chat if it makes sense?' },                 // hedging + banned
  { id: 'L07', good: false, firstName: 'Gray', company: 'Thessquorn Bio', body: 'Hi Gray,\nSaw the de-identification project.\nWe help with that.\nOpen to a chat?' },                   // 4 lines
  { id: 'L08', good: false, firstName: 'Harper', company: 'Nuvasquell', body: 'Hi {{first_name}}, saw the new trust page at Nuvasquell. Worth a chat?' },                           // placeholder
  { id: 'L09', good: false, firstName: 'Avery', company: 'Exquorra Pay', body: 'Hi Avery, hope this finds you well! Exquorra Pay is doing great things! Can we chat? When are you free?' }, // banned + asks + exclaim
  { id: 'L10', good: false, firstName: 'Blake', company: 'Saffrevane Health', body: `Hi Blake, ${'we help healthcare teams keep sensitive records isolated, tokenized and governed across every region they operate in, '.repeat(3)}worth a chat?` }, // too long
  { id: 'L11', good: false, firstName: 'Casey', company: 'Durnaquill', body: 'Hi Casey, saw the API launch - curious how you handle PII?' },                                         // spaced hyphen as dash
  { id: 'L12', good: true, firstName: 'Drew', company: 'Fyndraquel Insure', body: 'Drew, saw Fyndraquel Insure posted a privacy engineer role. Is claims data residency on that hire\'s list?' },
  { id: 'L13', good: false, firstName: 'Emery', company: 'Moquadrel', body: 'Hi there, I think our platform could possibly help your team. Thoughts?' },                       // hedges + not personal
  { id: 'L14', good: true, firstName: 'Gray', company: 'Thessquorn Bio', body: 'Hi Gray, the de-identification project at Thessquorn Bio caught my eye. Worth comparing notes on trial data?' },
];

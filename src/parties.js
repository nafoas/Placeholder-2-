// The parties a President can lead. Party Support is a stripped-down version of
// the public-support system: instead of 24 personas, ONE evaluation per turn
// contrasts the policy against the party's core values and scores how strongly
// the party faithful back it. The President always leads one of these parties.

export const PARTIES = {
  usp: {
    id: "usp", name: "USP", full: "United Sordland Party",
    core:
      "The USP is the Sollist party of government — the founder's own. Its core: preserve Tarquin Soll's settlement " +
      "and the directed, protectionist Sollist economy; civic Sordish nationalism and national unity; order, " +
      "continuity, and a strong state; the army and armed neutrality. It will tolerate cautious, gradual democratic " +
      "reform, but recoils from anything that repudiates Sollism, privatises heavily, or unravels the founder's order.",
  },
  pfjp: {
    id: "pfjp", name: "PFJP", full: "People's Front — liberal & social-democratic reformers",
    core:
      "The PFJP is the liberal and social-democratic opposition. Its core: democratisation, civil liberties, the " +
      "rule of law, and minority rights; rolling back the strongman's authoritarian residue; a mixed economy that " +
      "blends market freedom with real social welfare. It cheers reform and openness, and bristles at authoritarian " +
      "nationalism, repression, and the cult of the founder.",
  },
  nfp: {
    id: "nfp", name: "NFP", full: "National Front — the nationalist right",
    core:
      "The NFP is the nationalist right. Its core: ethnic Sordish nationalism and a hard line on the Bludish; a " +
      "powerful military and national strength; a protectionist, statist economy; order, discipline, and " +
      "anti-communism. It applauds strength and Sordish primacy, and despises liberal reform, minority accommodation, " +
      "and anything that looks like weakness at home or abroad.",
  },
};

export const DEFAULT_PARTY = "usp";

export function getParty(id) {
  return PARTIES[id] || PARTIES[DEFAULT_PARTY];
}

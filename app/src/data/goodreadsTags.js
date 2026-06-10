// Curated Goodreads reader-tag vocabulary for the Books tag builder's
// autocomplete. These are real Goodreads "shelf" names people use; the worker
// slugifies the display name (e.g. "M/M Romance" → "m-m-romance") to hit
// goodreads.com/shelf/show/<slug>. Free-text entry still works for anything
// not listed — this is just suggestions.
export const GOODREADS_TAGS = [
  // genres
  'Fantasy', 'Romance', 'Science Fiction', 'Mystery', 'Thriller', 'Horror',
  'Historical Fiction', 'Contemporary', 'Young Adult', 'New Adult', 'Literary Fiction',
  'Nonfiction', 'Memoir', 'Biography', 'Poetry', 'Graphic Novels', 'Manga', 'Comics',
  'Crime', 'Dystopia', 'Adventure', 'Classics', 'Humor', 'Philosophy', 'History',
  'Western', 'Coming Of Age',
  // speculative
  'Urban Fantasy', 'Epic Fantasy', 'High Fantasy', 'Dark Fantasy', 'Space Opera',
  'Cyberpunk', 'Steampunk', 'Magical Realism', 'Gothic', 'Paranormal',
  'Time Travel', 'Post Apocalyptic', 'Zombies', 'Vampires', 'Werewolves', 'Shifters',
  'Fae', 'Dragons', 'Witches', 'Mythology', 'Retellings', 'Pirates', 'Superheroes',
  // settings / eras
  'Regency', 'Victorian', 'Academia', 'Magic School', 'Small Town', 'Royalty',
  // romance flavours + tropes (the reader-tag richness)
  'LGBT', 'Queer', 'M/M Romance', 'F/F Romance', 'Gay', 'Lesbian', 'Bisexual', 'Trans',
  'Sports Romance', 'Hockey', 'Dark Romance', 'Mafia Romance', 'Rockstar Romance',
  'Billionaire Romance', 'Royal Romance', 'Paranormal Romance', 'Romantic Suspense',
  'Enemies To Lovers', 'Friends To Lovers', 'Slow Burn', 'Grumpy Sunshine', 'Fake Dating',
  'Second Chance Romance', 'Forced Proximity', 'Found Family', 'Age Gap', 'Forbidden Love',
  'Love Triangle', 'Marriage Of Convenience', 'Workplace Romance', 'Holiday Romance',
  // mystery/thriller flavours
  'Cozy Mystery', 'Psychological Thriller', 'True Crime', 'Noir', 'Spy Thriller',
];

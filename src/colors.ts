const colors = {
  "hsl(0, 0%, 0%)": {},
  "hsl(0, 0%, 33%)": {},
  "hsl(0, 0%, 67%)": {},
  "hsl(0, 0%, 100%)": {},
  "hsl(0, 67%, 67%)": {},
  "hsl(60, 67%, 67%)": {},
  "hsl(120, 67%, 67%)": {},
  "hsl(180, 67%, 67%)": {},
  "hsl(240, 67%, 67%)": {},
  "hsl(300, 67%, 67%)": {},
  "hsl(0, 33%, 33%)": {},
  "hsl(60, 33%, 33%)": {},
  "hsl(120, 33%, 33%)": {},
  "hsl(180, 33%, 33%)": {},
  "hsl(240, 33%, 33%)": {},
  "hsl(300, 33%, 33%)": {},
};

type ColorType = keyof typeof colors;

export { colors };
export type { ColorType };

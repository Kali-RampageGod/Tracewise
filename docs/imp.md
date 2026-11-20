# Score

How the release score is calculated (`src/score/engine.js`):

1. Start at 100. Each open finding takes points off.
2. Bigger problems take more points (low 2, medium 5, high 10, critical 25).
3. Unsure findings take less: evidence confidence 80 or more counts fully, 40 to 79 counts 25%, below 40 counts nothing.
4. One type of problem can't take off too much (secret 60, decision conflict 30, gate 40, other 30).
5. Bands: 80 or more is Ready, 50 to 79 is At risk, below 50 is Blocked.
6. A confirmed critical secret means Blocked, whatever the score.

All numbers live in `DEFAULT_CONFIG` in `engine.js`. Change them there.
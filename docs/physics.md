# Physics and measurement contract

> **Heat means modeled review exposure. It is not defect probability, a quality score, or a verdict about neighboring code.**

## One substrate, two interpretations

[Fovea](https://github.com/fabric-runtime/pi-fovea) owns graph assembly and the numerical solver. Contour consumes the versioned `pi-fovea/substrate` API with immutable syntax facts. It neither parses rendered navigation output nor substitutes a live session graph for the staged snapshot.

Symbols and files are nodes. Typed witnesses explain each relationship. Contour uses an undirected conductance projection for exposure; imports remain directed for cycles and explicit boundary policies. An undirected heat field is not a causal dependency proof.

## Sources, conductance, transport

Let $W$ be the symmetric nonnegative conductance matrix, $D$ its degree matrix, and $q$ a nonnegative source vector. For positive-degree nodes:

$$
D_{ii}=\sum_j W_{ij}, \qquad L_{\mathrm{sym}}=I-D^{-1/2}WD^{-1/2}.
$$

The symmetric-normalized heat field is useful computationally, but its ordinary sum is not generally conserved. Contour therefore uses the forward, column-mass conjugation:

$$
p(t)=D^{1/2}e^{-tL_{\mathrm{sym}}}D^{-1/2}q.
$$

Equivalently, with the column-mass random-walk Laplacian:

$$
L_{\mathrm{m}}=I-WD^{-1}, \qquad p(t)=e^{-tL_{\mathrm{m}}}q.
$$

This gives the conservation law, up to floating-point error:

$$
\mathbf{1}^{\mathsf T}p(t)=\mathbf{1}^{\mathsf T}q.
$$

Degree-zero nodes are handled separately: $p_i(t)=q_i$. There is no invented leakage from an isolated source, and no division by zero.

Each selected finding seeds **one unit** at its primary witnessed symbol/file. Findings remain separate; branch counts are not added to duplicated lines to manufacture a common quality unit. Times $t\in\{0.5,2,8\}$ are neighborhood scales, **not elapsed development time**. Diffusion transports exposure; it does not heal old technical debt.

### Contour's projection

| Relationship | Conductance | Evidence restriction |
|---|---:|---|
| Containment | $0.5$ | File membership |
| Import | $1.0$ | Unambiguous direct relative import |
| Call | $0.7$ | Single-candidate local/imported name resolution |

Possible targets, globally unique name guesses, and bare-import suffix heuristics do not enter this exposure projection. Clone similarity stays a separate evidence relation, not an invented runtime call. These weights define an analysis model; they are not empirically calibrated maintenance-risk parameters.

## Shared Chebyshev work

Set $M=L_{\mathrm{sym}}-I$, whose spectrum lies in $[-1,1]$. Fovea evaluates:

$$
e^{-tL_{\mathrm{sym}}}=e^{-t}\left[I_0(t)T_0(M)+2\sum_{k\geq1}(-1)^k I_k(t)T_k(M)\right],
$$

where $T_k$ are Chebyshev polynomials and $I_k$ are modified Bessel functions. For $s=D^{-1/2}q$, the reusable vectors satisfy:

$$
u_0=s,\qquad u_1=Ms,\qquad u_{k+1}=2Mu_k-u_{k-1}.
$$

One recurrence per source/operator serves every requested timescale by recombining coefficients. A new $t$ does not require another graph traversal. Cached models belong to immutable content generations; report identities additionally pin the baseline, target, and configuration. Source changes never reuse stale node indices or old evidence.

## Multiscale boundary exposure

For a directory region $S$ containing the source:

$$
\ell_S(t)=\frac{\sum_{i\notin S}p_i(t)}{\sum_i q_i}.
$$

Reports preserve source mass, total transported mass, boundary exposure, nearby files, and the original source witnesses. Exposure can prioritize review **within a finding category**. Minimizing it is not a universal objective: integration code and shared infrastructure often have high exposure for good reasons. Directories are proxies, not inferred semantic feature boundaries.

## Local measurements remain visible

Following the metric family discussed in [Earendil's article](https://earendil.com/posts/measuring-code-sloppiness/) and [SlopCodeBench](https://arxiv.org/html/2603.24755v1):

$$
m(f)=\mathrm{CC}(f)\sqrt{\mathrm{SLOC}(f)},\qquad
E=\frac{\sum_{f:\mathrm{CC}(f)>10}m(f)}{\sum_f m(f)}.
$$

For flagged syntax lines $A$ and exact-token clone lines $C$:

$$
V=\frac{|A\cup C|}{\mathrm{SLOC}}.
$$

Zero denominators produce zero, not undefined values. Contour reports the numerators and absolute totals alongside these ratios. Its small JS/TS rule set is **not a reproduction of the benchmark's entire methodology or calibration**.

Regional decision counts supplement callable erosion. Extracting helpers changes CC baselines and function mass; a falling erosion ratio does not establish that the underlying decision load fell. Nor does replacing duplicates with one heavily coupled abstraction necessarily improve a design.

## Evaluation, not decoration

Human review supplies intent and architectural expectations. Tests supply behavioral evidence. The useful outcome is whether people and agents make subsequent changes with fewer regressions and less unnecessary coordination—not whether a scalar score falls.

Driven diffusion, screened Green's functions, effective resistance, and temporal co-change remain research directions. Numerical solver correctness is necessary, but does not establish that exposure predicts maintenance cost. No such predictive claim is made by this release.

---
book: EBS 올림포스 대수 유형편
page: 239
ocrModel: gemini-2.0-flash
unit: 시중교재
type: EBS 올림포스 대수 유형편
difficulty: 미분류난이도
sourceImage: EBS 올림포스 대수 유형편/pages/page239.png
---

## OCR_본문

①에 n=1을 대입하면 ㉠에서 구한 값과 같으므로
$a_n = 2n+1$
$$\sum_{k=1}^{10} \frac{1}{a_k a_{k+2}} = \sum_{k=1}^{10} \frac{1}{(2k+1)(2k+5)}$$
$$= \frac{1}{4} \sum_{k=1}^{10} \left( \frac{1}{2k+1} - \frac{1}{2k+5} \right)$$
$$= \frac{1}{4} \times \left\{ \left( \frac{1}{3} - \frac{1}{7} \right) + \left( \frac{1}{5} - \frac{1}{9} \right) + \left( \frac{1}{7} - \frac{1}{11} \right) + \cdots + \left( \frac{1}{19} - \frac{1}{23} \right) + \left( \frac{1}{21} - \frac{1}{25} \right) \right\}$$
$$= \frac{1}{4} \times \left( \frac{1}{3} + \frac{1}{5} - \frac{1}{23} - \frac{1}{25} \right)$$
$$= \frac{1}{4} \times \frac{69}{25}$$
따라서 $p=5$

[그림: ⑤]

31 $\sum_{k=1}^{n} \frac{1}{\sqrt{3k-2} + \sqrt{3k+1}}$
$$= \sum_{k=1}^{n} \frac{\sqrt{3k-2} - \sqrt{3k+1}}{(\sqrt{3k-2} + \sqrt{3k+1})(\sqrt{3k-2} - \sqrt{3k+1})}$$
$$= - \frac{1}{3} \sum_{k=1}^{n} (\sqrt{3k-2} - \sqrt{3k+1})$$
$$= - \frac{1}{3} \left\{ (\sqrt{1} - \sqrt{4}) + (\sqrt{4} - \sqrt{7}) + (\sqrt{7} - \sqrt{10}) + \cdots + (\sqrt{3n-2} - \sqrt{3n+1}) \right\}$$
$$= - \frac{1}{3} (1 - \sqrt{3n+1})$$
$\sum_{k=1}^{n} \frac{1}{\sqrt{3k-2} + \sqrt{3k+1}} = 4$에서
$-\frac{1}{3} (1 - \sqrt{3n+1}) = 4$
$\sqrt{3n+1} = 13, 3n = 168$
따라서 $n = 56$

[그림: ③]

32 자연수 $n$에 대하여 $x+2y = 4n+2$를 만족시키는 두 자연수 $x, y$의 순서쌍 $(x, y)$의 개수는
$(4n, 1), (4n-2, 2), (4n-4, 3), \cdots, (2, 2n)$의 $2n$이므로
$a_n = 2n$
따라서
$\sum_{k=1}^{24} \frac{1}{\sqrt{a_k} + \sqrt{a_{k+1}}} = \sum_{k=1}^{24} \frac{1}{\sqrt{2k} + \sqrt{2k+2}}$
$$= \sum_{k=1}^{24} \frac{\sqrt{2k} - \sqrt{2k+2}}{(\sqrt{2k} + \sqrt{2k+2})(\sqrt{2k} - \sqrt{2k+2})}$$
$$= - \frac{1}{2} \sum_{k=1}^{24} (\sqrt{2k} - \sqrt{2k+2})$$
$$= - \frac{1}{2} \times \left\{ (\sqrt{2} - \sqrt{4}) + (\sqrt{4} - \sqrt{6}) + (\sqrt{6} - \sqrt{8}) + \cdots + (\sqrt{48} - \sqrt{50}) \right\}$$
$$= - \frac{1}{2} \times (\sqrt{2} - \sqrt{50})$$
$$= 2\sqrt{2}$$

[그림: ③]

33 점 $A$의 좌표는 $(n, \sqrt{n})$, 점 $B$의 좌표는 $(n, 0)$이므로
$S_n = \frac{1}{2} n \sqrt{n}$
따라서
$\sum_{k=1}^{15} \frac{3k^2 + 3k + 1}{S_k + S_{k+1}} = \sum_{k=1}^{15} \frac{3k^2 + 3k + 1}{\frac{1}{2} k \sqrt{k} + \frac{1}{2} (k+1) \sqrt{k+1}}$
$$= 2 \sum_{k=1}^{15} \frac{3k^2 + 3k + 1}{k \sqrt{k} + (k+1) \sqrt{k+1}}$$
$$= 2 \sum_{k=1}^{15} \frac{(3k^2 + 3k + 1)(k \sqrt{k} - (k+1) \sqrt{k+1})}{\{ k \sqrt{k} + (k+1) \sqrt{k+1} \} \{ k \sqrt{k} - (k+1) \sqrt{k+1} \}}$$
$$= 2 \sum_{k=1}^{15} \frac{(3k^2 + 3k + 1)(k \sqrt{k} - (k+1) \sqrt{k+1})}{k^3 - (k+1)^3}$$
$$= -2 \sum_{k=1}^{15} \left( k \sqrt{k} - (k+1) \sqrt{k+1} \right)$$
$$= -2 \left\{ (\sqrt{1} - 2 \sqrt{2}) + (2 \sqrt{2} - 3 \sqrt{3}) + (3 \sqrt{3} - 4 \sqrt{4}) + \cdots + (15 \sqrt{15} - 16 \sqrt{16}) \right\}$$
$$= -2 \times (1 - 16 \sqrt{16})$$
$$= 126$$

[그림: ㉠]
126

34 $\sum_{k=1}^{6} \sum_{i=1}^{k} (2ki) = \sum_{k=1}^{6} \left( \sum_{i=1}^{k} 2ki \right)$
$$= \sum_{k=1}^{6} \left\{ 2k \times \frac{k(k+1)}{2} \right\}$$
$$= \sum_{k=1}^{6} (k^3 + k^2)$$
$$= \sum_{k=1}^{6} k^3 + \sum_{k=1}^{6} k^2$$
$$= \left( \frac{6 \times 7}{2} \right)^2 + \frac{6 \times 7 \times 13}{6}$$
$$= 532$$

[그림: ②]

35 $\sum_{k=1}^{7} \left[ \sum_{i=1}^{k} \{ k(k-1) + 2i - 1 \} \right]$
$$= \sum_{k=1}^{7} \left[ \sum_{i=1}^{k} \{ k(k-1) \times k + 2 \sum_{i=1}^{k} i - 1 \times k \} \right]$$
$$= \sum_{k=1}^{7} \left\{ k^3 - k^2 + 2 \times \frac{k(k+1)}{2} - k \right\}$$
$$= \sum_{k=1}^{7} k^3$$
$$= \left( \frac{7 \times 8}{2} \right)^2$$
$$= 784$$

[그림: ④]

36 $n \ge 2$일 때
$\sum_{i=1}^{n} \left( \sum_{k=1}^{i} 6k \right)$
$$= \sum_{i=1}^{n} \left( \sum_{k=1}^{i} 6k - \sum_{k=1}^{i-1} 6k \right)$$
$$= \sum_{i=1}^{n} \left( 6 \sum_{k=1}^{i} k - 6 \sum_{k=1}^{i-1} k \right)$$

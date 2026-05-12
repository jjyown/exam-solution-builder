---
book: EBS 올림포스 대수 유형편
page: 110
ocrModel: gemini-2.0-flash
unit: 시중교재
type: EBS 올림포스 대수 유형편
difficulty: 미분류난이도
sourceImage: EBS 올림포스 대수 유형편/pages/page110.png
---

## OCR_본문

개념 확인하기
06 수열의 합과 수학적 귀납법
Ⅲ. 수열
01 합의 기호
(1) 수열 $\{a_n\}$의 첫째항부터 제$n$항까지의 합을 합의 기호 $\sum$를 사용하여
$a_1+a_2+a_3+\cdots+a_n=\sum_{k=1}^{n} a_k$
와 같이 나타낸다.
(2) $m \le n$일 때, 수열 $\{a_n\}$의 제$m$항부터 제$n$항까지의 합은
$a_m+a_{m+1}+a_{m+2}+\cdots+a_n = \sum_{k=m}^{n} a_k$
와 같이 나타낸다. 이것은 첫째항부터 제$n$항까지의 합에서 첫째항부터 제$(m-1)$항까지의 합을
뺀 것과 같으므로
$\sum_{k=m}^{n} a_k = \sum_{k=1}^{n} a_k - \sum_{k=1}^{m-1} a_k$ $(2 \le m \le n)$
이 성립한다.

```
제n항까지
Σak-일반항
k=1
제1항부터
4를 차례로 더한다.
```
기호 $\sum$는 합을 뜻하는 영어 단어
Summation의 첫 글자 S에 해당하는 그리스 알파벳의 대문자이며, '시그마(sigma)'라고 읽는다.

*   $\sum_{k=1}^{n} a_k$에서 $k$ 대신에 $i$ 또는 $j$ 등의 다른 문자를 사용하여 나타낼 수도 있다.
    즉,
    $\sum_{k=1}^{n} a_k = \sum_{i=1}^{n} a_i = \sum_{j=1}^{n} a_j$
*   $\sum_{k=1}^{n} (pa_k+qb_k) = p\sum_{k=1}^{n} a_k + q\sum_{k=1}^{n} b_k$
    (단, $p$, $q$는 상수)
*   $\sum_{k=1}^{n} a_k b_k \ne \left(\sum_{k=1}^{n} a_k\right)\left(\sum_{k=1}^{n} b_k\right)$
    $\sum_{k=1}^{n} \frac{a_k}{b_k} \ne \frac{\sum_{k=1}^{n} a_k}{\sum_{k=1}^{n} b_k}$

02 합의 기호 $\sum$의 성질
두 수열 $\{a_n\}$, $\{b_n\}$에 대하여
(1) $\sum_{k=1}^{n} (a_k+b_k) = \sum_{k=1}^{n} a_k + \sum_{k=1}^{n} b_k$
(2) $\sum_{k=1}^{n} (a_k-b_k) = \sum_{k=1}^{n} a_k - \sum_{k=1}^{n} b_k$
(3) $\sum_{k=1}^{n} ca_k = c\sum_{k=1}^{n} a_k$ (단, $c$는 상수)
(4) $\sum_{k=1}^{n} c = c+c+c+\cdots+c=cn$ (단, $c$는 상수)
$\qquad\qquad\qquad\qquad\qquad$ $n$개

03 자연수의 거듭제곱의 합
(1) $\sum_{k=1}^{n} k = 1+2+3+\cdots+n = \frac{n(n+1)}{2}$
(2) $\sum_{k=1}^{n} k^2 = 1^2+2^2+3^2+\cdots+n^2 = \frac{n(n+1)(2n+1)}{6}$
(3) $\sum_{k=1}^{n} k^3 = 1^3+2^3+3^3+\cdots+n^3 = \left[ \frac{n(n+1)}{2} \right]^2$

04 일반항이 분수 꼴인 수열의 합
(1) 서로 다른 두 일차식의 곱이 분모인 유리식을 일반항으로 갖는 수열의 합은 각 항을 두 개의 항
으로 분리하여 구한다.

<보기>
$\sum_{k=1}^{n} \frac{1}{k(k+1)} = \sum_{k=1}^{n} \left( \frac{1}{k} - \frac{1}{k+1} \right) = \left( \frac{1}{1} - \frac{1}{2} \right) + \left( \frac{1}{2} - \frac{1}{3} \right) + \left( \frac{1}{3} - \frac{1}{4} \right) + \cdots + \left( \frac{1}{n} - \frac{1}{n+1} \right)$
$= 1 - \frac{1}{n+1}$
</보기>

(2) 서로 다른 두 무리식의 합이 분모인 식을 일반항으로 갖는 수열의 합은 분모를 유리화하여 구한다.

<보기>
$\sum_{k=1}^{n} \frac{1}{\sqrt{k}+\sqrt{k+1}} = \sum_{k=1}^{n} \frac{\sqrt{k} - \sqrt{k+1}}{(\sqrt{k}+\sqrt{k+1})(\sqrt{k}-\sqrt{k+1})} = - \sum_{k=1}^{n} (\sqrt{k+1} - \sqrt{k})$
$=-\{(\sqrt{1}-\sqrt{2})+(\sqrt{2}-\sqrt{3})+(\sqrt{3}-\sqrt{4})+\cdots+(\sqrt{n}-\sqrt{n+1})\}$
$=-(\sqrt{1}-\sqrt{n+1})$
$=-1+\sqrt{n+1}$
</보기>

$\frac{1}{AB} = \frac{1}{B-A} \left( \frac{1}{A} - \frac{1}{B} \right)$
(단, $A \ne B$, $A \ne 0$, $B \ne 0$)

110 올림포스 유형편·대수

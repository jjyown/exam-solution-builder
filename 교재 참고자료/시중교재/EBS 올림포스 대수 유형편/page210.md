---
book: EBS 올림포스 대수 유형편
page: 210
ocrModel: gemini-2.0-flash
unit: 시중교재
type: EBS 올림포스 대수 유형편
difficulty: 미분류난이도
sourceImage: EBS 올림포스 대수 유형편/pages/page210.png
---

## OCR_본문

cos $A = \frac{b^2+c^2-a^2}{2bc} = \frac{b^2+b^2-(\frac{2}{3}b)^2}{2b^2}$
$= \frac{2-\frac{4}{9}}{2} = \frac{\frac{7}{9}}{2} = \frac{7}{9}$

$0 < A < \pi$이므로

$\sin A = \sqrt{1-\cos^2 A} = \sqrt{1-(\frac{7}{9})^2} = \frac{4\sqrt{2}}{9}$

삼각형 ABC의 외접원의 넓이가 $2\pi$이므로 $R=\sqrt{2}$

사인법칙에 의하여 $\frac{a}{\sin A} = 2R$

$\frac{a}{\frac{4\sqrt{2}}{9}} = 2\sqrt{2}$

따라서 $a=2\sqrt{2} \times \frac{4\sqrt{2}}{9} = \frac{16}{9}$

즉, $BC = \frac{16}{9}$

<다른 풀이>
$b=c$, $b=\frac{3}{2}a$에서

$\cos B = \frac{\frac{1}{2}a}{\frac{3}{2}a} = \frac{1}{3}$

$0 < B < \pi$이므로

$\sin B = \sqrt{1-\cos^2 B} = \frac{2\sqrt{2}}{3}$

삼각형 ABC에서 사인법칙에 의하여

$\frac{CA}{\sin B} = 2R$

$\frac{\frac{3}{2}a}{\frac{2\sqrt{2}}{3}} = 2R$

삼각형 ABC의 외접원의 넓이가 $2\pi$이므로 $R=\sqrt{2}$

$\frac{3}{2}a = 2\sqrt{2} \times \frac{2\sqrt{2}}{3} = \frac{8}{3}$

따라서 $BC = \frac{2}{3} \times CA = \frac{16}{9}$

03

삼각형 ABC의 외접원의 반지름의 길이
를 $R$이라 하자.

사인법칙에 의하여 $\frac{AC}{\sin B} = 2R$, $\frac{AB}{\sin C} = 2R$이므로

$\sin B = \frac{AC}{2R}$, $\sin C = \frac{AB}{2R}$

$4\sin B = 3\sin C$에서 $4\times \frac{AC}{2R} = 3 \times \frac{AB}{2R}$

$4 \times AC = 3 \times AB$이므로 $AB = 4a$, $AC = 3a$ $(a>0)$이라 하자.

또한 선분 BC를 1:2로 내분하는 점이 D이므로
$\overline{BD} = b$, $\overline{DC} = 2b$ $(b>0)$이라 하자.

$\overline{AD} = k$ $(k>0)$이라 하면

$\cos B = 3 \cos C$에서

$\frac{(4a)^2+b^2-k^2}{2 \times 4a \times b} = 3 \times \frac{(2b)^2+(3a)^2-k^2}{2 \times 2b \times 3a}$

$\frac{16a^2+b^2-k^2}{2} = \frac{4b^2+9a^2-k^2}{1}$

$k^2 = 2a^2 + 7b^2$ ......㉠

한편, $\cos(\angle BDA) = \cos(\pi - \angle CDA) = -\cos(\angle CDA)$이므로

$\frac{b^2+k^2-(4a)^2}{2 \times b \times k} = -\frac{k^2+(2b)^2-(3a)^2}{2 \times k \times 2b}$

$\frac{b^2+k^2-16a^2}{1} = -\frac{k^2+4b^2-9a^2}{2}$

$k^2 = \frac{41}{3}a^2 - 2b^2$ ......㉡

㉠, ㉡에서 $2a^2 + 7b^2 = \frac{41}{3}a^2 - 2b^2$

$a^2 = \frac{27}{35}b^2$

이를 ㉡에 대입하면

$k^2 = \frac{41}{3} \times \frac{27}{35}b^2 - 2b^2 = \frac{299}{35}b^2$

따라서 $\frac{AD^2}{BD^2} = \frac{k^2}{b^2} = \frac{299}{35}$

답 $\frac{299}{35}$

04

$0 < \angle BAC < \pi$이므로

$\sin(\angle BAC) = \sqrt{1-\cos^2(\angle BAC)} = \sqrt{1-(\frac{4}{5})^2} = \frac{3}{5}$

삼각형 ABC의 외접원의 반지름의 길이가 5이므로 사인법칙에 의하여

$\frac{BC}{\sin(\angle BAC)} = 2 \times 5$

$BC = 10 \times \frac{3}{5} = 6$

선분 BC를 1:2로 내분하는 점이 D이므로

$\overline{BD} = 6 \times \frac{1}{3} = 2$, $\overline{CD} = 6 \times \frac{2}{3} = 4$

$\overline{BE} = \overline{CE}$에서 $\angle CBE = \angle BCE$이고 원주각
의 성질에 의하여

$\angle CAE = \angle CBE$, $\angle BAE = \angle BCE$이므로
직선 AD는 각 BAC를 이등분한다.

삼각형 ABD와 삼각형 ADC의 넓이를 각각
S₁, S₂라 하면

$S_1 = \frac{1}{2} \times \overline{AB} \times \overline{AD} \times \sin(\angle BAD)$

$S_2 = \frac{1}{2} \times \overline{AD} \times \overline{AC} \times \sin(\angle CAD)$

이때 $S_1:S_2 = \overline{BD}:\overline{CD} = 1:2$이므로

$\overline{AB}:\overline{AC} = \overline{BD}:\overline{CD} = 1:2$

$\overline{AB} = a$, $\overline{AC} = 2a$ $(a>0)$이라 하면 삼각형 ABC에서 코사인법칙에
의하여

$\overline{BC}^2 = \overline{AC}^2 + \overline{AB}^2 - 2 \times \overline{AC} \times \overline{AB} \times \cos(\angle BAC)$

$6^2 = (2a)^2 + a^2 - 2 \times 2a \times a \times (-\frac{4}{5})$

$36 = \frac{41}{5}a^2$, $a^2 = \frac{180}{41}$

삼각형 ABC의 넓이는

$\frac{1}{2} \times \overline{AB} \times \overline{AC} \times \sin(\angle BAC) = \frac{1}{2} \times a \times 2a \times \frac{3}{5} = \frac{3}{5}a^2$

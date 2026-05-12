---
book: EBS 올림포스 대수 유형편
page: 208
ocrModel: gemini-2.0-flash
unit: 시중교재
type: EBS 올림포스 대수 유형편
difficulty: 미분류난이도
sourceImage: EBS 올림포스 대수 유형편/pages/page208.png
---

## OCR_본문

02 삼각형 ABC에서 AB=c, BC=a, CA=b라 하자.
$$cos B=\frac{c^2+a^2-b^2}{2ca}=\frac{4^2+3^2-b^2}{2 \times 4 \times 3}=\frac{25-b^2}{24}$$
세 선분 AB, BC, CA가 삼각형 ABC의 세 변이므로
a+b>c, a+c>b이어야 한다.
즉, 1<b<7
$b$가 자연수이므로 $b$는 $2 \le b \le 6$인 자연수이다.
$4 \le b^2 \le 36$에서
$$\frac{11}{24} \le \frac{25-b^2}{24} \le \frac{7}{8}$$
즉, $-\frac{11}{24} \le cos B \le \frac{7}{8}$
$$0 \le cos^2 B \le (\frac{7}{8})^2$$
$0 < B < \pi$이므로 $sin B = \sqrt{1-cos^2 B}$에서
$$\sqrt{1-(\frac{7}{8})^2} \le \sqrt{1-cos^2 B} \le 1$$
$$\frac{\sqrt{15}}{8} \le sin B \le 1$$
따라서 $sin B$의 최댓값은 CA=5일 때 1이고,

최솟값은 CA=2일 때 $\frac{\sqrt{15}}{8}$이다.

답 최댓값: 1, 최솟값: $\frac{\sqrt{15}}{8}$

| 단계 | 채점 기준                                            | 비율 |
| ---- | --------------------------------------------------- | ---- |
| 1    | $cos B$를 변의 길이에 대한 식으로 표현한 경우               | 20%  |
| 2    | $cos B$의 값의 범위를 구한 경우                           | 40%  |
| 3    | $sin B$의 최댓값과 최솟값을 각각 구한 경우                   | 40%  |

$\overline{AB}=c, \overline{BC}=a, \overline{CA}=b$라 하면
$$cos A=\frac{b^2+c^2-a^2}{2bc}, cos B=\frac{c^2+a^2-b^2}{2ca},$$
$$cos C=\frac{a^2+b^2-c^2}{2ab}$$이므로
$\overline{AB} \times cos C + \overline{BC} \times cos A + \overline{CA} \times cos (C+A)=0$에서
$$c \times \frac{a^2+b^2-c^2}{2ab} + a \times \frac{b^2+c^2-a^2}{2bc} + b \times \frac{c^2+a^2-b^2}{2ca} = 0$$
$$c^2(a^2+b^2-c^2) + a^2(b^2+c^2-a^2) = b^2(c^2+a^2-b^2)$$
$$a^4 - 2a^2c^2 + c^4 = b^4$$
$$(a^2-c^2)^2 = b^4$$
$$a^2 - c^2 = b^2 또는 a^2 - c^2 = -b^2$$
$$a^2 = b^2 + c^2 또는 c^2 = a^2 + b^2$$
즉, 삼각형 ABC는 $\angle A = \frac{\pi}{2}$인 직각삼각형이거나 $\angle C = \frac{\pi}{2}$인 직각삼각형이다.
이때 $sin A = \frac{5}{13} \ne 1$에서 $\angle A \ne \frac{\pi}{2}$이므로
삼각형 ABC는 $\angle C = \frac{\pi}{2}$인 직각삼각형이다.

$0 < A < \frac{\pi}{2}$이므로 $cos A = \sqrt{1 - sin^2 A} = \sqrt{1 - (\frac{5}{13})^2} = \frac{12}{13}$

$\angle C = \frac{\pi}{2}$에서 $cos A = \frac{b}{c}$이고 CA=b=6이므로
$$\frac{6}{c} = \frac{12}{13}, c = \frac{13}{2}$$
$sin A = \frac{a}{c}$에서 $\frac{a}{13/2} = \frac{5}{13}$이므로 $a = \frac{5}{2}$
따라서 삼각형 ABC의 넓이는
$$\frac{1}{2}ab = \frac{1}{2} \times \frac{5}{2} \times 6 = \frac{15}{2}$$

답 $\frac{15}{2}$

| 단계 | 채점 기준                                            | 비율 |
| ---- | --------------------------------------------------- | ---- |
| 1    | 주어진 식을 변의 길이를 이용하여 표현한 경우               | 30%  |
| 2    | 삼각형 ABC의 모양을 알아낸 경우                           | 30%  |
| 3    | 삼각형 ABC의 넓이를 구한 경우                           | 40%  |

03 삼각형 ACD에서 $\angle DAC = \theta$라 하면
$\overline{AD} // \overline{BC}$이므로 $\angle BCA = \theta$이다.
삼각형 ACD에서 코사인법칙에 의하여
$$cos \theta = \frac{\overline{AC}^2 + \overline{AD}^2 - \overline{CD}^2}{2 \times \overline{AC} \times \overline{AD}}$$
$$=\frac{7^2 + 4^2 - 5^2}{2 \times 7 \times 4} = \frac{5}{7}$$
삼각형 ABC에서 코사인법칙에 의하여
$$\overline{AB}^2 = \overline{BC}^2 + \overline{CA}^2 - 2 \times \overline{BC} \times \overline{CA} \times cos \theta$$
$$=9^2 + 7^2 - 2 \times 9 \times 7 \times \frac{5}{7} = 40$$
$\overline{AB} > 0$이므로 $\overline{AB} = 2 \sqrt{10}$

답 $2\sqrt{10}$

| 단계 | 채점 기준                                                | 비율 |
| ---- | ------------------------------------------------------- | ---- |
| 1    | 평행선의 성질을 이용하여 같은 각을 찾아낸 경우                       | 10%  |
| 2    | $cos(\angle DAC)$의 값을 구한 경우                           | 50%  |
| 3    | $\overline{AB}$의 값을 구한 경우                               | 40%  |

04 삼각형 ABC에서 $A+B+C=\pi$이므로
$C+A = \pi - B$
$cos (C+A) = cos (\pi - B) = -cos B$

05 선분 AB를 3 : 1로 내분하는 점이 D이므로 $\overline{AD} = 3, \overline{BD} = 1$
선분 BC를 3 : 1로 내분하는 점이 E이므로 $\overline{BE} = 3$
삼각형 ABE에서 코사인법칙에 의하여
$$\overline{AE}^2 = \overline{AB}^2 + \overline{BE}^2 - 2 \times \overline{AB} \times \overline{BE} \times cos(\angle ABE)$$
$$= 4^2 + 3^2 - 2 \times 4 \times 3 \times cos \frac{\pi}{3} = 13$$
$\overline{AE} > 0$이므로 $\overline{AE} = \sqrt{13}$

$$cos(\angle EAD) = \frac{\overline{AE}^2 + \overline{AB}^2 - \overline{BE}^2}{2 \times \overline{AE} \times \overline{AB}}$$
$$= \frac{(\sqrt{13})^2 + 4^2 - 3^2}{2 \times \sqrt{13} \times 4} = \frac{5}{2\sqrt{13}}$$
삼각형 DBE에서 코사인법칙에 의하여
$$\overline{DE}^2 = \overline{BD}^2 + \overline{BE}^2 - 2 \times \overline{BD} \times \overline{BE} \times cos \frac{\pi}{3}$$
$$= 1^2 + 3^2 - 2 \times 1 \times 3 \times \frac{1}{2} = 7$$

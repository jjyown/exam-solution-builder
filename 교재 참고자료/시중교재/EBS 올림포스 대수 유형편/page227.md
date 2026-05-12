---
book: EBS 올림포스 대수 유형편
page: 227
ocrModel: gemini-2.0-flash
unit: 시중교재
type: EBS 올림포스 대수 유형편
difficulty: 미분류난이도
sourceImage: EBS 올림포스 대수 유형편/pages/page227.png
---

## OCR_본문

64 등비수열 $\{a_n\}$의 첫째항을 $a$, 공비를 $r$이라 하면 모든 항이 양수
이므로 $a>0$, $r>0$
$r=1$이면 $S_{12}=9S_6$에서 $12a=9 \times 6a$이므로 $a=0$이 되어 조건 $a>0$
을 만족시키지 않는다.
그러므로 $r \ne 1$
$S_6 = \frac{a(r^6-1)}{r-1} = 6$ ...... ㉠
$S_{12} = \frac{a(r^{12}-1)}{r-1} = \frac{a(r^6+1)(r^6-1)}{r-1}$
$S_6 = \frac{a(r^6-1)}{r-1}$
이므로 $S_{12} = 9S_6$에서
$\frac{a(r^6+1)(r^6-1)}{r-1} = \frac{9a(r^6-1)}{r-1}$
$r^6+1 = 9$
$r^6 = (r^2)^3 = 8$, $r^2=2$
$r>0$이므로 $r = \sqrt{2}$
이를 ㉠에 대입하면
$\frac{a\{(\sqrt{2})^6-1\}}{\sqrt{2}-1} = 6$
$a \times \frac{3}{\sqrt{2}-1} = 6$
$a = 2(\sqrt{2}-1) = 2\sqrt{2}-2$
따라서 $a_1 = 2\sqrt{2}-2$

65 등비수열 $\{a_n\}$의 첫째항이 양수이므로 $a_1 > 0$
$S_{3k} = \frac{a_1(r^{3k}-1)}{r-1} = \frac{a_1(r^k-1)(r^{2k}+r^k+1)}{r-1}$
$S_k = \frac{a_1(r^k-1)}{r-1}$
$S_{3k} = 3S_k$에서 $\frac{a_1(r^k-1)(r^{2k}+r^k+1)}{r-1} = \frac{3a_1(r^k-1)}{r-1}$
$r \ne -1$, $r \ne 1$이므로 $r^k - 1 \ne 0$에서
$r^{2k} + r^k + 1 = 3$
$r^{2k} + r^k - 2 = 0$, $(r^k-1)(r^k+2) = 0$
$r \ne -1$, $r \ne 1$이므로 $r^k + 2 = 0$
$r^k = -2$
수열 $\{\frac{1}{a_n}\}$은 첫째항이 $\frac{1}{a_1}$이고 공비가 $\frac{1}{r}$인 등비수열이므로
$\frac{1}{a_1} + \frac{1}{a_2} + \frac{1}{a_3} + ... + \frac{1}{a_k} + rS_k = 0$에서
$\frac{\frac{1}{a_1} \{1-(\frac{1}{r})^k\}}{1-\frac{1}{r}} + rS_k = 0$
$\frac{\frac{1}{a_1} \{1-(\frac{1}{r})^k\}}{1-\frac{1}{r}} + \frac{ra_1(r^k-1)}{r-1} = 0$
$\frac{\frac{r}{a_1} \{1-(\frac{1}{r})^k\}}{r-1} + \frac{ra_1(r^k-1)}{r-1} = 0$
$r^k = -2$이므로 $-\frac{r}{a_1} (1 + \frac{1}{2}) + a_1(-2-1) = 0$
$\frac{r}{a_1} = \frac{1}{2}$
따라서 $a_1 > 0$이므로 $a_1 = \frac{\sqrt{2}}{2}$

66 정삼각형 $A_1B_1C_1$의 한 변의 길이는 4이므로
$l_1 = 3 \times 4$
정삼각형 $A_2B_2C_2$의 한 변의 길이는 $4 \times \frac{1}{2}$이므로
$l_2 = 3 \times 4 \times \frac{1}{2}$
정삼각형 $A_3B_3C_3$의 한 변의 길이는 $4 \times (\frac{1}{2})^2$이므로
$l_3 = 3 \times 4 \times (\frac{1}{2})^2$
:
정삼각형 $A_nB_nC_n$의 한 변의 길이는 $4 \times (\frac{1}{2})^{n-1}$ 이므로
$l_n = 3 \times 4 \times (\frac{1}{2})^{n-1}$
즉, 수열 $\{l_n\}$은 첫째항이 12, 공비가 $\frac{1}{2}$인 등비수열이다.
$l_1 + l_2 + l_3 + ... + l_8 = \frac{12 \times \{1 - (\frac{1}{2})^8\}}{1-\frac{1}{2}}$
$= 24 \times (1 - \frac{1}{256})$
$= 24 \times \frac{255}{256}$
$= \frac{3}{32} \times 765$
따라서 $p=32, q=765$이므로
$p+q = 32 + 765 = 797$

67 직사각형 $A_2B_2C_2D_2$에서 $A_2D_2 = a$라 하면
$A_2B_2 = 2a$ ...... ㉠
$\angle B_1A_1C_1 = \angle A_1D_2A_2$에서 두 직각삼각형 $A_1B_1C_1$, $D_2A_2A_1$은 서로
닮음이므로
$A_1A_2 = \frac{1}{2}a$ ...... ㉡
$\angle B_1A_1C_1 = \angle C_2C_1B_2$에서 두 직각삼각형 $A_1B_1C_1$, $C_1B_2C_2$는 서로 닮
음이므로
$\overline{B_2C_1} = 2a$ ...... ㉢
㉠, ㉡, ㉢에서
$\overline{A_1C_1} = \overline{A_1A_2} + \overline{A_2B_2} + \overline{B_2C_1}$
$= \frac{1}{2}a + 2a + 2a = \frac{9}{2}a$
한편, 직각삼각형 $A_1B_1C_1$에서 피타고라스 정리에 의하여
$\overline{A_1C_1}^2 = \overline{A_1B_1}^2 + \overline{B_1C_1}^2 = 2^2 + 1^2 = 5$
$\overline{A_1C_1} = \sqrt{5}$
그러므로 $\frac{9}{2}a = \sqrt{5}$에서
$a = \frac{2\sqrt{5}}{9}$
즉, $B_1C_1 : B_2C_2 = 1 : \frac{2\sqrt{5}}{9}$ 이므로
두 삼각형 $A_1B_1C_1$, $A_2B_2C_2$의 닮음비는 $1 : \frac{2\sqrt{5}}{9}$.
넓이의 비는 $1 : \frac{20}{81}$이다.

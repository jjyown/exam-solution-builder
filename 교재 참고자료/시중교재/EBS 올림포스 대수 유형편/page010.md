---
book: EBS 올림포스 대수 유형편
page: 10
ocrModel: gemini-2.0-flash
unit: 시중교재
type: EBS 올림포스 대수 유형편
difficulty: 미분류난이도
sourceImage: EBS 올림포스 대수 유형편/pages/page010.png
---

## OCR_본문

개념 확인하기
05 로그의 성질
a>0, a≠1이고 M>0, N>0일 때
(1) $\log_a 1=0$, $\log_a a=1$
(2) $\log_a MN=\log_a M+\log_a N$
(3) $\log_a \frac{M}{N}=\log_a M-\log_a N$
(4) $\log_a M^k=k \log_a M$ (단, $k$는 실수)
- $a>0, a\neq 1$일 때
$a^0=1, a^1=a$이므로
로그의 정의에 의하여
$\log_a 1=0, \log_a a=1$
- $a>0, a\neq 1$일 때
$\log_a \frac{1}{N}=-\log_a N$ (단, $N>0$)
$\log_a a^k=k \log_a a=k$ (단, $k$는 실수)
06 로그의 밑의 변환
(1) 로그의 밑의 변환
$a>0, a\neq 1, b>0, c>0, c\neq 1$일 때
$\log_a b=\frac{\log_c b}{\log_c a}$
증명 $\log_b=x$, $\log_c a=y$로 놓으면 $b=a^x$, $a=c^y$이므로 지수법칙에 의하여 $b=a^x=(c^y)^x=c^{xy}$
로그의 정의에 의하여 $xy=\log_c b$, $\log_c b=\log_c b \times \log_c a=\log_c b$
$a\neq 1$에서 $\log_c a\neq 0$이므로 $\log_a b=\frac{\log_c b}{\log_c a}$
(2) 로그의 밑의 변환의 활용
$a>0, a\neq 1, b>0$일 때
①$\log_a b=\frac{1}{\log_b a}$ (단, $b\neq 1$)
②$\log_a b \times \log_c a=\log_c b$ (단, $b\neq 1, c>0$)
③$\log_{a^n} b^m = \frac{m}{n} \log_a b$ (단, $m, n$은 실수, $m \neq 0$)
④$a^{\log_c c}=c^{\log_c a}$ (단, $b\neq 1, c>0$)
07 상용로그
(1) 상용로그의 정의
양수 $N$에 대하여 $\log_{10} N$과 같이 밑이 10인 로그를 상용로그라 하고, 보통 밑 10을 생략하여 $\log N$과 같이 나타낸다.
(2) 상용로그표
상용로그표는 0.01의 간격으로 1.00에서 9.99까지의 수에 대한
상용로그의 값을 소수 다섯째 자리에서 반올림하여 소수 넷째
자리까지 구한 근삿값을 나타낸 것이다.
예를 들어 상용로그표를 이용하여 $\log 2.34$의 값을 찾으려면
2.3의 가로행과 4의 세로열이 만나는 곳의 수 .3692를 찾으면
된다.
즉, $\log 2.34=0.3692$이다.
(3) 상용로그표의 활용
| 수  | 0    | 1    | 2    | 3    | 4     | 5    | 6    | 7    | 8    | 9    |
| --- | ---- | ---- | ---- | ---- | ----- | ---- | ---- | ---- | ---- | ---- |
| 1.0 |      |      |      |      |       |      |      |      |      |      |
| :   |      |      |      |      |       |      |      |      |      |      |
| 2.3 |      |      |      |      | .3692 |      |      |      |      |      |
| :   |      |      |      |      |       |      |      |      |      |      |
| 9.9 |      |      |      |      |       |      |      |      |      |      |
- $c\neq 1$일 때 $a=c^x$이라 하면
$x=\log_c a$이므로
$a^{\log_c c}=(c^{\log_c a})^{\log_c c}=c^{\log_c a \times \log_c c}=c^{\log_c a}$
$c=1$일 때
$a^{\log_c c}=a^{\log_c 1}=a^0=1$
$c^{\log_c a}=1^{\log_c a}=1$
이므로 $a^{\log_c c}=c^{\log_c a}$
- $\log 10 = \log_{10} 10 = 1$
$\log \frac{1}{100} = \log_{10} 10^{-2}$
$=-2 \log_{10} 10$
$=-2$
$\log \sqrt{10} = \log_{10} 10^{\frac{1}{2}}$
$=\frac{1}{2} \log_{10} 10$
$=\frac{1}{2}$
상용로그표와 로그의 성질을 이용하면 상용로그표에 없는 양수의 상용로그의 값을 구할 수 있다.
10 올림포스 유형편·대수

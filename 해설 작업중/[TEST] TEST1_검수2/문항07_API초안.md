[정답]
6

[해설]
반지름의 길이가 1인 반원의 호 AB를 12등분하므로, 각 점 $\mathrm{P}_k$ (단, $k=1, 2, \ldots, 11$)와 원점 O를 잇는 선분 $\mathrm{OP}_k$는 선분 AB와 이루는 각의 크기는 다음과 같다.
$\angle \mathrm{AOP}_k = \frac{\pi}{12} k$
점 $\mathrm{P}_k$에서 선분 AB에 내린 수선의 발을 $\mathrm{Q}_k$라고 할 때, $\triangle \mathrm{OP}_k\mathrm{Q}_k$는 직각삼각형이다.
이때, $\overline{\mathrm{P}_k\mathrm{Q}_k}$는 $\triangle \mathrm{OP}_k\mathrm{Q}_k$에서 $\angle \mathrm{POQ}_k$에 대한 대변의 길이가 된다.
$\overline{\mathrm{P}_k\mathrm{Q}_k} = \overline{\mathrm{OP}_k} \sin(\angle \mathrm{POQ}_k)$
반지름의 길이가 1이므로 $\overline{\mathrm{OP}_k} = 1$이다.
따라서, $\overline{\mathrm{P}_k\mathrm{Q}_k} = 1 \cdot \sin\left(\frac{\pi k}{12}\right) = \sin\left(\frac{\pi k}{12}\right)$
구하고자 하는 값은 $\sum_{k=1}^{11} \overline{\mathrm{P}_k\mathrm{Q}_k}^2$ 이므로,
$\sum_{k=1}^{11} \sin^2\left(\frac{\pi k}{12}\right)$
이다.
삼각함수의 성질에 의해 $\sin^2 x + \cos^2 x = 1$ 이고, $\sin(\pi - x) = \sin x$ 이므로,
$\sin^2\left(\frac{\pi k}{12}\right) = \sin^2\left(\pi - \frac{\pi k}{12}\right) = \sin^2\left(\frac{\pi(12-k)}{12}\right)$
이다.
따라서,
$\sin^2\left(\frac{\pi}{12}\right) = \sin^2\left(\frac{11\pi}{12}\right)$
$\sin^2\left(\frac{2\pi}{12}\right) = \sin^2\left(\frac{10\pi}{12}\right)$
$\sin^2\left(\frac{3\pi}{12}\right) = \sin^2\left(\frac{9\pi}{12}\right)$
$\sin^2\left(\frac{4\pi}{12}\right) = \sin^2\left(\frac{8\pi}{12}\right)$
$\sin^2\left(\frac{5\pi}{12}\right) = \sin^2\left(\frac{7\pi}{12}\right)$
이다.
또한, $\sin^2\left(\frac{6\pi}{12}\right) = \sin^2\left(\frac{\pi}{2}\right) = 1^2 = 1$ 이다.
구하는 합은 다음과 같이 계산된다.
$\sum_{k=1}^{11} \sin^2\left(\frac{\pi k}{12}\right) = \sin^2\left(\frac{\pi}{12}\right) + \sin^2\left(\frac{2\pi}{12}\right) + \ldots + \sin^2\left(\frac{5\pi}{12}\right) + \sin^2\left(\frac{6\pi}{12}\right) + \sin^2\left(\frac{7\pi}{12}\right) + \ldots + \sin^2\left(\frac{11\pi}{12}\right)$
$= 2 \left( \sin^2\left(\frac{\pi}{12}\right) + \sin^2\left(\frac{2\pi}{12}\right) + \sin^2\left(\frac{3\pi}{12}\right) + \sin^2\left(\frac{4\pi}{12}\right) + \sin^2\left(\frac{5\pi}{12}\right) \right) + \sin^2\left(\frac{6\pi}{12}\right)$
$\sin^2\left(\frac{\pi}{12}\right) + \sin^2\left(\frac{5\pi}{12}\right) = \sin^2\left(\frac{\pi}{12}\right) + \cos^2\left(\frac{\pi}{2} - \frac{5\pi}{12}\right) = \sin^2\left(\frac{\pi}{12}\right) + \cos^2\left(\frac{\pi}{12}\right) = 1$
마찬가지로,
$\sin^2\left(\frac{2\pi}{12}\right) + \sin^2\left(\frac{4\pi}{12}\right) = 1$
$\sin^2\left(\frac{3\pi}{12}\right) = \sin^2\left(\frac{\pi}{4}\right) = \left(\frac{\sqrt{2}}{2}\right)^2 = \frac{1}{2}$
$\sin^2\left(\frac{6\pi}{12}\right) = \sin^2\left(\frac{\pi}{2}\right) = 1$
따라서,
$2 \left( 1 + 1 + \frac{1}{2} \right) + 1 = 2 \left( \frac{5}{2} \right) + 1 = 5 + 1 = 6$
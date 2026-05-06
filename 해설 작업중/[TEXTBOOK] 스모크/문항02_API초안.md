[정답]
2
[해설]
주어진 등식 $5\sin\theta + 12 = 12\tan\theta$ 에서 $\tan\theta = \frac{\sin\theta}{\cos\theta}$ 이므로,
$5\sin\theta + 12 = 12\frac{\sin\theta}{\cos\theta}$
양변에 $\cos\theta$ 를 곱하면 (단, $\cos\theta \ne 0$)
$(5\sin\theta + 12)\cos\theta = 12\sin\theta$
$5\sin\theta\cos\theta + 12\cos\theta = 12\sin\theta$
$5\sin\theta\cos\theta - 12\sin\theta + 12\cos\theta = 0$

이 식을 $\sin\theta - \cos\theta$ 의 값으로 정리하기 위해, $\sin\theta - \cos\theta = k$ 로 치환하면 $\sin\theta = \cos\theta + k$ 이다.
또한, $\sin^2\theta + \cos^2\theta = 1$ 이므로, $(\cos\theta + k)^2 + \cos^2\theta = 1$
$\cos^2\theta + 2k\cos\theta + k^2 + \cos^2\theta = 1$
$2\cos^2\theta + 2k\cos\theta + k^2 - 1 = 0$

한편, $\sin\theta\cos\theta = \frac{1}{2}((\sin\theta - \cos\theta)^2 - (\sin^2\theta + \cos^2\theta)) = \frac{1}{2}(k^2 - 1)$ 이다.
이를 $5\sin\theta\cos\theta - 12\sin\theta + 12\cos\theta = 0$ 에 대입하면,
$5 \cdot \frac{1}{2}(k^2 - 1) - 12(\sin\theta - \cos\theta) = 0$
$\frac{5}{2}(k^2 - 1) - 12k = 0$
양변에 2를 곱하면
$5(k^2 - 1) - 24k = 0$
$5k^2 - 24k - 5 = 0$
$(5k+1)(k-5) = 0$
따라서 $k = 5$ 또는 $k = -\frac{1}{5}$ 이다.

$\sin\theta - \cos\theta = k$ 에서 $k$ 의 최댓값은 $\sqrt{1^2+(-1)^2} = \sqrt{2}$ 이고, 최솟값은 $-\sqrt{2}$ 이다.
따라서 $k=5$ 는 불가능하다.
그러므로 $k = \sin\theta - \cos\theta = -\frac{1}{5}$ 이다.

따라서 구하는 값은 $-\frac{1}{5}$ 이다.
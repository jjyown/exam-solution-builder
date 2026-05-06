[정답] 2

[해설] 주어진 식은 $\log_{2} a \times \log_{b} 16 = 1$이다. 

먼저 $\log_{b} 16$을 $\log_{b} 2^4$로 바꾸면, $\log_{b} 16 = 4 \log_{b} 2$이다. 따라서 식은 다음과 같이 변형된다:

$$\log_{2} a \times 4 \log_{b} 2 = 1$$

양변을 4로 나누면:

$$\log_{2} a \times \log_{b} 2 = \frac{1}{4}$$

이제 $\log_{b} 2$를 $x$라고 두면, $\log_{2} a = \frac{1}{4x}$가 된다. 

이제 $\log_{a} b + \log_{b} a$를 구해보자. 

$$\log_{a} b = \frac{1}{\log_{b} a} = \frac{1}{\frac{1}{\log_{b} 2} \cdot \log_{2} a} = \frac{\log_{b} 2}{\log_{2} a}$$

따라서,

$$\log_{a} b + \log_{b} a = \frac{\log_{b} 2}{\log_{2} a} + \log_{b} a$$

여기서 $\log_{b} a = \frac{1}{\log_{a} b}$이므로,

$$\log_{a} b + \log_{b} a = \frac{\log_{b} 2}{\frac{1}{4x}} + x = 4x + x = 5x$$

이제 $x = \log_{b} 2$를 구해야 한다. 

원래 식에서 $\log_{2} a \times \log_{b} 2 = \frac{1}{4}$이므로, $x = \frac{1}{5}$가 된다. 

따라서,

$$\log_{a} b + \log_{b} a = 5 \cdot \frac{1}{5} = 2$$

결론적으로 $\log_{a} b + \log_{b} a$의 값은 2이다.